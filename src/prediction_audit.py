"""Prediction Audit Card backend.

Normalized, read-only audit view over the immutable prediction history:
model_predictions (P1) + prediction_runs + market_quote_pairs + game_outcomes
+ bet_ledger + picks. The frontend never reconstructs prediction logic — this
module answers "what did the system know at that moment, which model produced
the probability, why did it decide BET/NO BET, and what happened afterwards".

Hard rules:
* Never fabricate data. A field that was not persisted for a prediction is
  returned as None and the UI renders "Not recorded".
* Market context must respect time: only quote pairs with
  fetched_at_utc <= prediction as_of are eligible as "market at prediction
  time". Closing quotes are reported separately (evaluation only).
* Feature contributions are derived from the persisted modelBreakdown of the
  actual heuristic_v1 calculation (the components sum to rawEdge exactly).
  If the breakdown is missing, contributions are empty — never invented.
"""

from __future__ import annotations

import json
import math
import sqlite3
from pathlib import Path
from typing import Any

from .utils import data_path

_SQLITE_PATH = data_path("state.sqlite")

NOT_RECORDED = "not_recorded"

# heuristic_v1 edge decomposition. Mirrors predictGameMoneylineCore
# (src/core/prediction_core.js): every persisted modelBreakdown component
# below is already post-weight/post-clamp, and the record-context group is
# multiplied by 0.45 when recordDominated is true. Their sum equals rawEdge.
_HEURISTIC_COMPONENTS = [
    # (feature, category, breakdown key, is record-context component)
    ("offense", "offense", "offenseEdge", False),
    ("run_prevention", "defense", "preventionEdge", False),
    ("starting_pitcher", "starting_pitcher", "starterEdge", False),
    ("lineup", "lineup", "lineupEdge", False),
    ("bullpen", "bullpen", "bullpenEdge", False),
    ("schedule_fatigue", "rest", "fatigueEdge", False),
    ("season_record_log5", "recent_form", "log5Edge", True),
    ("recent_form", "recent_form", "formEdge", True),
    ("head_to_head", "contextual", "h2hEdge", True),
    ("model_memory", "contextual", "memoryEdge", True),
    ("platoon_split", "handedness", "platoonEdge", True),
    ("home_field", "park", "homeFieldEdge", False),
    ("weather", "weather", "weatherEdge", False),
    ("lineup_confirmation", "lineup", "confirmationEdge", False),
]

_RECORD_DOMINATED_MULTIPLIER = 0.45


def _connect(db_path: Path) -> sqlite3.Connection | None:
    if not Path(db_path).exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error:
        try:
            conn = sqlite3.connect(str(db_path))
        except sqlite3.Error:
            return None
    conn.row_factory = sqlite3.Row
    return conn


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
    ).fetchone()
    return row is not None


def _loads(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return None


def _num(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _minutes_between(earlier: str | None, later: str | None) -> float | None:
    """Minutes from `earlier` to `later` (ISO strings); None when unknown."""
    if not earlier or not later:
        return None
    from datetime import datetime

    def parse(text: str):
        try:
            return datetime.fromisoformat(str(text).replace("Z", "+00:00"))
        except ValueError:
            return None

    a, b = parse(earlier), parse(later)
    if a is None or b is None:
        return None
    return round((b - a).total_seconds() / 60.0, 1)


# ---------------------------------------------------------------------------
# Feature contributions (heuristic_v1)
# ---------------------------------------------------------------------------

def build_heuristic_contributions(breakdown: dict[str, Any] | None) -> dict[str, Any]:
    """Derive per-component contributions from the persisted modelBreakdown.

    Contributions come in two honest units:
    * edge_contribution — the exact component value from the production
      formula; components sum to raw_edge (verified via decomposition_complete).
    * probability_points — linearized effect on the raw home probability
      (component * dampening * sigmoid'(dampened_edge) * 100). Approximate by
      construction (sigmoid is nonlinear) and labeled as such.
    """
    if not isinstance(breakdown, dict) or not breakdown:
        return {
            "available": False,
            "note": "Model breakdown was not recorded for this prediction.",
            "contributions": [],
        }

    record_dominated = bool(breakdown.get("recordDominated"))
    record_multiplier = _RECORD_DOMINATED_MULTIPLIER if record_dominated else 1.0

    raw_edge = _num(breakdown.get("rawEdge"))
    dampened_edge = _num(breakdown.get("dampenedEdge"))
    dampening = _num(breakdown.get("dampeningFactor"))

    derivative = None
    if dampened_edge is not None and dampening is not None:
        s = _sigmoid(dampened_edge)
        derivative = s * (1.0 - s)

    contributions = []
    total = 0.0
    any_component = False
    for feature, category, key, is_record_context in _HEURISTIC_COMPONENTS:
        value = _num(breakdown.get(key))
        if value is None:
            continue
        any_component = True
        edge_contribution = value * (record_multiplier if is_record_context else 1.0)
        total += edge_contribution
        prob_points = (
            round(edge_contribution * dampening * derivative * 100.0, 3)
            if derivative is not None and dampening is not None
            else None
        )
        contributions.append(
            {
                "feature": feature,
                "category": category,
                "value": round(value, 6),
                "edge_contribution": round(edge_contribution, 6),
                "probability_points": prob_points,
            }
        )

    if not any_component:
        return {
            "available": False,
            "note": "Model breakdown was recorded without component values.",
            "contributions": [],
        }

    decomposition_complete = (
        raw_edge is not None and abs(total - raw_edge) < 1e-6
    )
    contributions.sort(key=lambda item: abs(item["edge_contribution"]), reverse=True)
    return {
        "available": True,
        "method": "heuristic_v1_exact_edge_decomposition",
        "raw_edge": raw_edge,
        "dampened_edge": dampened_edge,
        "dampening_factor": dampening,
        "record_dominated": record_dominated,
        "component_sum": round(total, 6),
        "decomposition_complete": decomposition_complete,
        "probability_points_note": "Linearized around the dampened edge; approximate.",
        "contributions": contributions,
    }


# ---------------------------------------------------------------------------
# Data quality normalization
# ---------------------------------------------------------------------------

def _normalize_data_quality(
    quality: dict[str, Any] | None,
    availability: dict[str, Any] | None,
    fallbacks: dict[str, Any] | None,
    information_state: str | None,
) -> dict[str, Any]:
    fallback_features = set()
    if isinstance(fallbacks, dict):
        fallback_features = {str(f) for f in fallbacks.get("features") or []}

    inputs = []
    if isinstance(availability, dict):
        # feature key in featureAvailability -> fallback-feature name prefix
        fallback_map = {
            "teamSeasonAdvanced": "team_season_advanced",
            "probableStarters": "probable_starter_season",
            "probableStarterRecent": "probable_starter_recent",
        }
        for key, available in availability.items():
            state = "available" if available else "missing"
            mapped = fallback_map.get(key)
            if mapped and mapped in fallback_features:
                state = "fallback"
            inputs.append({"input": key, "state": state})

    lineup_state = None
    if information_state in ("confirmed_lineup", "confirmed"):
        lineup_state = "confirmed"
    elif information_state in ("projected_lineup", "projected"):
        lineup_state = "projected"
    elif information_state == "ineligible":
        lineup_state = "ineligible"

    status = None
    reasons = None
    if isinstance(quality, dict):
        status = quality.get("status")
        reasons = quality.get("reasons")

    recorded = bool(inputs) or status is not None or information_state is not None
    return {
        "recorded": recorded,
        "status": status,
        "reasons": reasons if isinstance(reasons, list) else None,
        "information_state": information_state,
        "lineup_state": lineup_state,
        "inputs": inputs,
        "fallback_features": sorted(fallback_features) or None,
    }


# ---------------------------------------------------------------------------
# Market context (temporal-safe)
# ---------------------------------------------------------------------------

def _quote_to_dict(row: sqlite3.Row | None, as_of: str | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "quote_pair_id": row["quote_pair_id"],
        "bookmaker": row["bookmaker"],
        "market": row["market"],
        "home_odds": _num(row["home_odds"]),
        "away_odds": _num(row["away_odds"]),
        "home_implied_probability": _num(row["home_implied_prob"]),
        "away_implied_probability": _num(row["away_implied_prob"]),
        "overround": _num(row["overround"]),
        "home_no_vig_probability": _num(row["home_no_vig_prob"]),
        "away_no_vig_probability": _num(row["away_no_vig_prob"]),
        "fetched_at_utc": row["fetched_at_utc"],
        "bookmaker_last_update": row["bookmaker_last_update"],
        "is_opening": bool(row["is_opening"]),
        "is_closing": bool(row["is_closing"]),
        "age_minutes_at_prediction": _minutes_between(row["fetched_at_utc"], as_of),
    }


def _market_context(
    conn: sqlite3.Connection,
    game_pk: str,
    paired_quote_pair_id: str | None,
    as_of: str | None,
) -> dict[str, Any]:
    if not _table_exists(conn, "market_quote_pairs"):
        return {"at_prediction": None, "closing": None, "source": None}

    at_prediction = None
    source = None
    if paired_quote_pair_id:
        row = conn.execute(
            "SELECT * FROM market_quote_pairs WHERE quote_pair_id = ?",
            (paired_quote_pair_id,),
        ).fetchone()
        # Paired quote is trusted only with PROVEN temporal provenance:
        # both timestamps known AND fetched_at <= as_of. A NULL fetched_at or
        # NULL as_of means provenance is unknown — never valid prediction-time
        # evidence.
        if (
            row is not None
            and as_of is not None
            and row["fetched_at_utc"] is not None
            and row["fetched_at_utc"] <= as_of
        ):
            at_prediction = _quote_to_dict(row, as_of)
            source = "paired"

    if at_prediction is None and as_of:
        row = conn.execute(
            """
            SELECT * FROM market_quote_pairs
            WHERE game_pk = ? AND market = 'moneyline' AND is_eligible = 1
              AND fetched_at_utc IS NOT NULL AND fetched_at_utc <= ?
            ORDER BY fetched_at_utc DESC
            LIMIT 1
            """,
            (str(game_pk), as_of),
        ).fetchone()
        if row is not None:
            at_prediction = _quote_to_dict(row, as_of)
            source = "nearest_pre_as_of"

    closing_row = conn.execute(
        """
        SELECT * FROM market_quote_pairs
        WHERE game_pk = ? AND market = 'moneyline' AND is_closing = 1 AND is_eligible = 1
        ORDER BY fetched_at_utc DESC
        LIMIT 1
        """,
        (str(game_pk),),
    ).fetchone()

    return {
        "at_prediction": at_prediction,
        "closing": _quote_to_dict(closing_row, None),
        "source": source,
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def list_audit_predictions(
    date_ymd: str | None = None,
    limit: int = 50,
    db_path: Path | None = None,
) -> dict[str, Any]:
    """List immutable model predictions for the audit selector."""
    conn = _connect(db_path or _SQLITE_PATH)
    if conn is None:
        return {"rows": [], "warning": "state.sqlite is not available"}
    try:
        if not _table_exists(conn, "model_predictions"):
            return {
                "rows": [],
                "warning": "model_predictions table not present (migration 006 not applied)",
            }
        limit = max(1, min(int(limit), 200))
        has_picks = _table_exists(conn, "picks")
        has_outcomes = _table_exists(conn, "game_outcomes")
        query = f"""
            SELECT mp.prediction_id, mp.run_id, mp.game_pk, mp.date_ymd,
                   mp.model_id, mp.model_impl_version, mp.status, mp.pick_side,
                   mp.pick_team_id, mp.pick_probability, mp.as_of_utc,
                   mp.information_state, mp.promotion_eligible, mp.created_at
                   {', p.matchup AS matchup' if has_picks else ", NULL AS matchup"}
                   {', o.game_pk IS NOT NULL AS has_result' if has_outcomes else ", 0 AS has_result"}
            FROM model_predictions mp
            {'LEFT JOIN picks p ON p.run_id = mp.run_id' if has_picks else ''}
            {'LEFT JOIN game_outcomes o ON o.game_pk = mp.game_pk' if has_outcomes else ''}
            WHERE (? IS NULL OR mp.date_ymd = ?)
            ORDER BY mp.date_ymd DESC, mp.created_at DESC
            LIMIT ?
        """
        rows = conn.execute(query, (date_ymd, date_ymd, limit)).fetchall()
        return {
            "rows": [
                {
                    "prediction_id": row["prediction_id"],
                    "run_id": row["run_id"],
                    "game_pk": row["game_pk"],
                    "date": row["date_ymd"],
                    "matchup": row["matchup"],
                    "model_id": row["model_id"],
                    "model_version": row["model_impl_version"],
                    "status": row["status"],
                    "pick_side": row["pick_side"],
                    "pick_probability": _num(row["pick_probability"]),
                    "information_state": row["information_state"],
                    "promotion_eligible": bool(row["promotion_eligible"]),
                    "has_result": bool(row["has_result"]),
                    "created_at": row["created_at"],
                }
                for row in rows
            ]
        }
    finally:
        conn.close()


def get_prediction_audit(
    prediction_id: str,
    db_path: Path | None = None,
) -> dict[str, Any] | None:
    """Return the normalized audit payload for one prediction, or None."""
    conn = _connect(db_path or _SQLITE_PATH)
    if conn is None:
        return None
    try:
        if not _table_exists(conn, "model_predictions"):
            return None
        mp = conn.execute(
            "SELECT * FROM model_predictions WHERE prediction_id = ?",
            (prediction_id,),
        ).fetchone()
        if mp is None:
            return None

        run = None
        if _table_exists(conn, "prediction_runs"):
            run = conn.execute(
                "SELECT * FROM prediction_runs WHERE run_id = ?", (mp["run_id"],)
            ).fetchone()
        pick = None
        if _table_exists(conn, "picks"):
            pick = conn.execute(
                "SELECT * FROM picks WHERE run_id = ? ORDER BY saved_at DESC LIMIT 1",
                (mp["run_id"],),
            ).fetchone()

        mp_payload = _loads(mp["payload"]) or {}
        run_payload = _loads(run["payload"]) if run is not None else None
        pick_payload = _loads(pick["payload"]) if pick is not None else None

        breakdown = mp_payload.get("modelBreakdown")
        if not isinstance(breakdown, dict) and isinstance(pick_payload, dict):
            breakdown = pick_payload.get("modelBreakdown")

        availability = mp_payload.get("featureAvailability")
        fallbacks = mp_payload.get("featureFallbacks")
        if not isinstance(availability, dict) and isinstance(pick_payload, dict):
            availability = pick_payload.get("featureAvailability")
        if not isinstance(fallbacks, dict) and isinstance(pick_payload, dict):
            fallbacks = pick_payload.get("featureFallbacks")

        teams = None
        matchup = pick["matchup"] if pick is not None else None
        if isinstance(pick_payload, dict):
            home = pick_payload.get("home") or {}
            away = pick_payload.get("away") or {}
            if home.get("name") or away.get("name"):
                teams = {
                    "home": {
                        "id": home.get("id"),
                        "name": home.get("name"),
                        "abbreviation": home.get("abbreviation"),
                    },
                    "away": {
                        "id": away.get("id"),
                        "name": away.get("name"),
                        "abbreviation": away.get("abbreviation"),
                    },
                }

        # Decision detail: model_predictions status/reason_codes are canonical
        # for the research row; the richer betDecision (odds, book, kelly,
        # human-readable reasons) comes from the pick payload when recorded.
        bet_decision = None
        if isinstance(pick_payload, dict) and isinstance(pick_payload.get("betDecision"), dict):
            bet_decision = pick_payload["betDecision"]
        elif isinstance(run_payload, dict) and isinstance(run_payload.get("betDecision"), dict):
            bet_decision = run_payload["betDecision"]

        reason_codes = _loads(mp["reason_codes"])
        decision_status = mp["status"]
        is_bet = str(decision_status or "").upper() in ("VALUE", "BET")
        decision = {
            "status": decision_status,
            "is_bet": is_bet,
            "pick_side": mp["pick_side"],
            "pick_team_id": mp["pick_team_id"],
            "pick_probability": _num(mp["pick_probability"]),
            "reason_codes": reason_codes if isinstance(reason_codes, list) else None,
            "reasons": None,
            "edge": None,
            "odds": None,
            "bookmaker": None,
            "kelly_stake_percent": None,
        }
        if isinstance(bet_decision, dict):
            reasons = bet_decision.get("reasons")
            decision.update(
                {
                    "status": bet_decision.get("status") or decision_status,
                    "reasons": reasons if isinstance(reasons, list) else (
                        [bet_decision["reason"]] if bet_decision.get("reason") else None
                    ),
                    "edge": _num(bet_decision.get("edge")),
                    "odds": _num(bet_decision.get("odds")),
                    "bookmaker": bet_decision.get("book"),
                    "kelly_stake_percent": _num(bet_decision.get("kellyStakePercent")),
                    "team_name": bet_decision.get("teamName"),
                }
            )
            decision["is_bet"] = str(decision["status"] or "").upper() in ("VALUE", "BET")

        market = _market_context(
            conn, mp["game_pk"], mp["paired_quote_pair_id"], mp["as_of_utc"]
        )

        # Result + settlement (evaluation-only data, reported separately).
        result = {"recorded": False}
        outcome = None
        if _table_exists(conn, "game_outcomes"):
            outcome = conn.execute(
                "SELECT * FROM game_outcomes WHERE game_pk = ?", (mp["game_pk"],)
            ).fetchone()
        if outcome is not None:
            winner_side = None
            if outcome["winner_team_id"] is not None and teams is not None:
                if str(outcome["winner_team_id"]) == str(teams["home"]["id"]):
                    winner_side = "home"
                elif str(outcome["winner_team_id"]) == str(teams["away"]["id"]):
                    winner_side = "away"
            if winner_side is None and outcome["home_score"] is not None and outcome["away_score"] is not None:
                winner_side = "home" if outcome["home_score"] > outcome["away_score"] else "away"
            result = {
                "recorded": True,
                "home_score": outcome["home_score"],
                "away_score": outcome["away_score"],
                "winner_team_id": outcome["winner_team_id"],
                "winner_side": winner_side,
                "prediction_correct": (
                    None if winner_side is None or mp["pick_side"] is None
                    else winner_side == mp["pick_side"]
                ),
            }

        ledger = None
        if _table_exists(conn, "bet_ledger"):
            ledger_row = conn.execute(
                """
                SELECT decision_id, team, side, odds, edge, units_staked, status,
                       result, units_pl, clv, recommended_at, settled_at
                FROM bet_ledger
                WHERE (run_id = ? OR game_pk = ?) AND market = 'moneyline'
                ORDER BY recommended_at DESC LIMIT 1
                """,
                (mp["run_id"], str(mp["game_pk"])),
            ).fetchone()
            if ledger_row is not None:
                ledger = {
                    "decision_id": ledger_row["decision_id"],
                    "team": ledger_row["team"],
                    "side": ledger_row["side"],
                    "odds": _num(ledger_row["odds"]),
                    "edge": _num(ledger_row["edge"]),
                    "units_staked": _num(ledger_row["units_staked"]),
                    "status": ledger_row["status"],
                    "result": ledger_row["result"],
                    "units_pl": _num(ledger_row["units_pl"]),
                    "clv": _num(ledger_row["clv"]),
                    "settled_at": ledger_row["settled_at"],
                }

        snapshot_path = None
        snapshot_available = False
        if isinstance(run_payload, dict) and run_payload.get("snapshotPath"):
            snapshot_path = str(run_payload["snapshotPath"])
            snapshot_available = Path(snapshot_path).exists()

        return {
            "prediction": {
                "prediction_id": mp["prediction_id"],
                "run_id": mp["run_id"],
                "game_pk": mp["game_pk"],
                "date": mp["date_ymd"],
                "matchup": matchup,
                "teams": teams,
                "as_of_utc": mp["as_of_utc"],
                "first_pitch_utc": mp["first_pitch_utc"],
                "created_at": mp["created_at"],
                "promotion_eligible": bool(mp["promotion_eligible"]),
                "promotion_reasons": _loads(mp["promotion_reasons"]),
            },
            "model": {
                "model_id": mp["model_id"],
                "model_version": mp["model_version"],
                "model_impl_version": mp["model_impl_version"],
                "feature_schema_version": mp["feature_schema_version"],
                "feature_version": mp["feature_version"],
                "calibration_version": mp["calibration_version"],
                "calibration_status": mp["calibration_status"],
                "calibration_artifact_hash": mp["calibration_artifact_hash"],
                "model_artifact_hash": mp["model_artifact_hash"],
                "snapshot_hash": mp["snapshot_hash"],
            },
            "probabilities": {
                "raw_home": _num(mp["raw_home_probability"]),
                "raw_away": _num(mp["raw_away_probability"]),
                "calibrated_home": _num(mp["calibrated_home_probability"]),
                "calibrated_away": _num(mp["calibrated_away_probability"]),
                "final_home": _num(mp["final_home_probability"]),
                "final_away": _num(mp["final_away_probability"]),
                "display_home": _num(mp["display_home_probability"]),
                "display_away": _num(mp["display_away_probability"]),
                "market_no_vig_home": _num(mp["market_no_vig_home_prob"]),
                "market_no_vig_away": _num(mp["market_no_vig_away_prob"]),
            },
            "decision": decision,
            "market": market,
            "dataQuality": _normalize_data_quality(
                (pick_payload or {}).get("predictionQuality")
                if isinstance(pick_payload, dict)
                else None,
                availability if isinstance(availability, dict) else None,
                fallbacks if isinstance(fallbacks, dict) else None,
                mp["information_state"],
            ),
            "contributions": build_heuristic_contributions(
                breakdown if isinstance(breakdown, dict) else None
            ),
            "result": result,
            "ledger": ledger,
            "replay": {
                "snapshot_hash": mp["snapshot_hash"],
                "snapshot_path": snapshot_path,
                "snapshot_available": snapshot_available,
            },
        }
    finally:
        conn.close()
