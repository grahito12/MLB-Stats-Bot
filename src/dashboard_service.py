"""Service layer for the FastAPI/React MLB prediction dashboard.

This module keeps dashboard business logic out of FastAPI routes and out of
React components. It can use live Node-backed MLB predictions, the local Python
sample pipeline, or mock data when external data is unavailable.
"""

from __future__ import annotations

import csv
import json
import logging
import os
import sqlite3
import subprocess
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from typing import Any

from .evaluate import (
    calculate_metrics,
    calibration_rows,
    load_prediction_log,
    performance_by_confidence,
    performance_by_market_total,
)
from .calibration import brier_score, calibration_table, log_loss
from .prediction_pipeline import run_prediction_pipeline
from .utils import data_path, safe_float

DEFAULT_DASHBOARD_SETTINGS: dict[str, Any] = {
    "minimum_moneyline_edge": 0.05,
    "minimum_data_quality_score": 60,
    "odds_stale_minutes": 15,
    "weather_stale_minutes": 60,
    "auto_refresh_minutes": 10,
    "low_confidence_threshold": 0.53,
    "medium_confidence_threshold": 0.57,
    "high_confidence_threshold": 0.62,
    "enable_weather_adjustment": True,
    "enable_umpire_adjustment": False,
    "enable_market_movement_adjustment": True,
}

_ROOT_DIR = Path(__file__).resolve().parents[1]
_SETTINGS_PATH = data_path("dashboard_settings.json")
_MOCK_PATH = data_path("dashboard_mock.json")
_TELEGRAM_STATE_PATH = data_path("state.json")
_SQLITE_PATH = data_path("state.sqlite")
_CACHE_DIR = data_path("cache")


def now_iso() -> str:
    """Return a UTC timestamp for dashboard payloads."""
    return datetime.now(timezone.utc).isoformat()


def _mtime_iso(path: Path) -> str | None:
    if not path.exists():
        return None
    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()


def _latest_mtime(patterns: list[str]) -> str | None:
    candidates: list[Path] = []
    for pattern in patterns:
        candidates.extend(_CACHE_DIR.glob(pattern))
    existing = [path for path in candidates if path.exists()]
    if not existing:
        return None
    latest = max(existing, key=lambda path: path.stat().st_mtime)
    return _mtime_iso(latest)


def _storage_status() -> dict[str, Any]:
    sqlite_exists = _SQLITE_PATH.exists()
    json_exists = _TELEGRAM_STATE_PATH.exists()
    status = "ok" if sqlite_exists or json_exists else "missing"
    detail = "SQLite state available" if sqlite_exists else "state.json available" if json_exists else "No persisted state file found"

    if sqlite_exists:
        try:
            conn = sqlite3.connect(str(_SQLITE_PATH))
            try:
                conn.execute("SELECT name FROM sqlite_master LIMIT 1").fetchone()
            finally:
                conn.close()
        except sqlite3.Error as exc:
            status = "error"
            detail = f"SQLite read failed: {exc}"

    return {
        "status": status,
        "detail": detail,
        "sqlite_path": str(_SQLITE_PATH),
        "json_path": str(_TELEGRAM_STATE_PATH),
        "last_state_write": _mtime_iso(_SQLITE_PATH) or _mtime_iso(_TELEGRAM_STATE_PATH),
    }


def get_health_status() -> dict[str, Any]:
    """Return operational status without exposing secrets."""
    prediction_log = data_path("predictions_log.csv")
    evolution_log = data_path("evolution/evolution_log.jsonl")
    last_prediction = _mtime_iso(prediction_log) or _mtime_iso(evolution_log)
    return {
        "status": "ok",
        "app": "mlb-stats-bot-dashboard-api",
        "timestamp": now_iso(),
        "last_successful_mlb_data_fetch": _latest_mtime(["*mlb*", "*statsapi*", "*schedule*"]),
        "last_odds_fetch": _latest_mtime(["*odds*", "*market*"]),
        "last_prediction_run": last_prediction,
        "storage": _storage_status(),
        "bot": {
            "status": "configured" if os.environ.get("TELEGRAM_BOT_TOKEN") else "not_configured",
            "auto_alerts": os.environ.get("AUTO_ALERTS", "").lower() in {"1", "true", "yes", "on"},
            "webhook_mode": os.environ.get("TELEGRAM_WEBHOOK_MODE", "").lower() in {"1", "true", "yes", "on"},
        },
    }


def _read_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return fallback
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_mock_dashboard() -> dict[str, Any]:
    """Load realistic mock data used when live APIs are unavailable."""
    return _read_json(_MOCK_PATH, {"today": {"games": []}, "history": [], "performance": {}, "backtest": {}})


def _read_telegram_state_from_sqlite() -> dict[str, Any] | None:
    """Read Telegram bot state from the SQLite database.

    Returns the same dict structure as the legacy state.json so downstream
    functions (history, performance, calibration) work unchanged.
    Returns None if the database is missing or unreadable.
    """
    if not _SQLITE_PATH.exists():
        return None

    try:
        conn = sqlite3.connect(str(_SQLITE_PATH))
        conn.row_factory = sqlite3.Row
        try:
            state: dict[str, Any] = {}

            # Metadata from app_state table
            for row in conn.execute("SELECT key, value FROM app_state"):
                if row["key"] == "lastUpdateId":
                    state["lastUpdateId"] = int(row["value"]) if row["value"].isdigit() else 0
                elif row["key"] == "lastAutoAlertDate":
                    state["lastAutoAlertDate"] = row["value"]

            # Memory from memory_summary table
            mem_row = conn.execute("SELECT * FROM memory_summary WHERE id = 1").fetchone()
            if mem_row:
                state["memory"] = {
                    "version": mem_row["version"],
                    "totalPicks": mem_row["total_picks"],
                    "correctPicks": mem_row["correct_picks"],
                    "wrongPicks": mem_row["wrong_picks"],
                    "byConfidence": json.loads(mem_row["by_confidence"] or "{}"),
                    "teamBias": json.loads(mem_row["team_bias"] or "{}"),
                    "matchupMemory": json.loads(mem_row["matchup_memory"] or "{}"),
                    "learningLog": json.loads(mem_row["learning_log"] or "[]"),
                }

            # Predictions from picks table
            predictions: dict[str, Any] = {}
            for row in conn.execute("SELECT game_pk, payload FROM picks"):
                try:
                    payload = json.loads(row["payload"] or "{}")
                    predictions[str(row["game_pk"])] = payload
                except (json.JSONDecodeError, TypeError):
                    continue
            state["predictions"] = predictions

            return state
        finally:
            conn.close()
    except (sqlite3.Error, OSError) as exc:
        logging.warning("Failed to read Telegram state from SQLite: %s", exc)
        return None


def load_telegram_state() -> dict[str, Any]:
    """Load Telegram bot state so dashboard history/performance mirrors the bot.

    Prefers the live SQLite database (used by the Node bot) over the legacy
    JSON file, which is only written once during initial migration and becomes
    stale as new predictions and outcomes are recorded.
    """
    sqlite_state = _read_telegram_state_from_sqlite()
    if sqlite_state is not None:
        return sqlite_state
    return _read_json(_TELEGRAM_STATE_PATH, {})


def load_dashboard_settings() -> dict[str, Any]:
    """Load dashboard thresholds, merging saved values with defaults."""
    saved = _read_json(_SETTINGS_PATH, {})
    return {**DEFAULT_DASHBOARD_SETTINGS, **saved}


def save_dashboard_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Persist dashboard threshold settings."""
    current = load_dashboard_settings()
    for key, default in DEFAULT_DASHBOARD_SETTINGS.items():
        if key not in settings:
            continue
        value = settings[key]
        if isinstance(default, bool):
            current[key] = bool(value)
        elif isinstance(default, int):
            current[key] = int(value)
        elif isinstance(default, float):
            current[key] = float(value)
        else:
            current[key] = value

    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _SETTINGS_PATH.open("w", encoding="utf-8") as handle:
        json.dump(current, handle, indent=2, sort_keys=True)
    return current


def _as_percent(value: Any) -> float | None:
    """Normalize decimal or percent probability to 0-100 scale."""
    if value in (None, ""):
        return None
    parsed = safe_float(value, 0.0)
    return round(parsed * 100.0 if abs(parsed) <= 1.0 else parsed, 1)


def _as_edge_pct(value: Any) -> float | None:
    """Normalize decimal or percentage-point edge to displayed percentage points."""
    if value in (None, ""):
        return None
    parsed = safe_float(value, 0.0)
    return round(parsed * 100.0 if abs(parsed) <= 1.0 else parsed, 1)


def _status(value: Any, fallback: str = "Missing") -> str:
    text = str(value or "").strip()
    return text if text else fallback


def _winner_from_probabilities(game: dict[str, Any]) -> tuple[str | None, float | None]:
    """Return predicted winner name and probability from a dashboard game."""
    moneyline = game.get("moneyline") or {}
    away_probability = safe_float(moneyline.get("away_probability"), 0.0)
    home_probability = safe_float(moneyline.get("home_probability"), 0.0)
    if home_probability >= away_probability:
        return game.get("home_team"), home_probability
    return game.get("away_team"), away_probability


_VALUE_STATUS_TO_DECISION = {
    "VALUE": "BET",
    "LEAN ONLY": "LEAN",
    "NO BET": "NO BET",
}


def _decision_from_value(value: dict[str, Any]) -> str:
    """Map the bot's moneyline value-engine status to a dashboard decision.

    The bot's betDecision.status (VALUE / LEAN ONLY / NO BET) already encodes the
    58% conviction floor and safety guardrails, so the dashboard should mirror it
    rather than recompute its own threshold logic.
    """
    return _VALUE_STATUS_TO_DECISION.get(str(value.get("status") or "").upper(), "NO BET")


def _format_odds(odds: Any) -> str:
    """Render American odds with an explicit sign, matching the bot's display."""
    parsed = safe_float(odds, None)
    if parsed is None:
        return ""
    return f"+{int(round(parsed))}" if parsed > 0 else f"{int(round(parsed))}"


def _decision_from_game(game: dict[str, Any], settings: dict[str, Any]) -> tuple[str, str]:
    quality = safe_float(game.get("data_quality", {}).get("score"), 0.0)
    moneyline_edge = abs(safe_float(game.get("moneyline", {}).get("edge"), 0.0))
    confidence = str(game.get("moneyline", {}).get("confidence") or "Low").lower()
    no_bet_reason = game.get("no_bet_reason") or ""
    minimum_moneyline_edge = safe_float(settings.get("minimum_moneyline_edge", 0.04), 0.04) * 100

    if no_bet_reason:
        return "NO BET", no_bet_reason
    if quality < safe_float(settings.get("minimum_data_quality_score", 60.0), 60.0):
        return "NO BET", "Data quality score below minimum threshold"
    if game.get("probable_pitchers", {}).get("status") in {"Missing", "TBD"}:
        return "NO BET", "Missing probable pitcher"
    if quality >= 85 and confidence == "high" and moneyline_edge >= 4.0:
        return "BET", ""
    if moneyline_edge >= minimum_moneyline_edge:
        return "LEAN", ""
    return "NO BET", "Moneyline edge below minimum threshold"

def _summarize_today(games: list[dict[str, Any]], source: str, warning: str | None = None) -> dict[str, Any]:
    if source == "live":
        _log_evolution_trajectories(games)
    bet_count = sum(1 for game in games if game.get("decision") == "BET")
    lean_count = sum(1 for game in games if game.get("decision") == "LEAN")
    no_bet_count = sum(1 for game in games if game.get("decision") == "NO BET")
    quality_values = [safe_float(game.get("data_quality", {}).get("score"), 0.0) for game in games]
    average_quality = round(sum(quality_values) / len(quality_values), 1) if quality_values else 0.0
    return {
        "source": source,
        "last_updated": now_iso(),
        "warning": warning,
        "summary": {
            "total_games": len(games),
            "bet_count": bet_count,
            "lean_count": lean_count,
            "no_bet_count": no_bet_count,
            "average_data_quality": average_quality,
        },
        "games": games,
    }


def _log_evolution_trajectories(games: list[dict[str, Any]]) -> None:
    """Best-effort pre-game trajectory logging for generated dashboard predictions."""
    try:
        from .evolution.trajectory_logger import log_prediction_trajectory

        for game in games:
            log_prediction_trajectory(game, game)
    except Exception:
        return


def _mock_today(settings: dict[str, Any], warning: str | None = None) -> dict[str, Any]:
    payload = load_mock_dashboard().get("today", {})
    games = []
    for raw_game in payload.get("games", []):
        game = dict(raw_game)
        predicted_winner, predicted_probability = _winner_from_probabilities(game)
        game["predicted_winner"] = game.get("predicted_winner") or predicted_winner
        game["predicted_winner_probability"] = game.get("predicted_winner_probability") or predicted_probability
        decision, reason = _decision_from_game(game, settings)
        game["decision"] = decision
        game["no_bet_reason"] = reason
        games.append(game)
    return _summarize_today(games, "mock", warning)


def _quality_from_live(game: dict[str, Any]) -> dict[str, Any]:
    quality = game.get("quality") or {}
    fields = quality.get("fields") or {}
    return {
        "score": quality.get("score", 0),
        "probable_pitchers": fields.get("probablePitchers", {}).get("status", "Missing"),
        "lineup": fields.get("lineup", {}).get("status", "Missing"),
        "weather": fields.get("weather", {}).get("status", "Missing"),
        "odds": fields.get("odds", {}).get("status", "Unavailable"),
        "bullpen_usage": fields.get("bullpen", {}).get("status", "Missing"),
        "park_factor": fields.get("park", {}).get("status", "Missing"),
        "injury_news": "Available" if "injury context" not in quality.get("missingFields", []) else "Missing",
        "market_movement": "Unavailable",
        "missing_fields": quality.get("missingFields", []),
        "stale_fields": quality.get("staleFields", []),
        "confidence_adjustments": quality.get("confidenceAdjustments", []),
        "issues": quality.get("missingFields", []) + quality.get("confidenceAdjustments", []),
    }


def _live_game_to_dashboard(game: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any]:
    quality = _quality_from_live(game)
    totals = game.get("totals") or game.get("total_runs") or game.get("totalRuns") or {}
    value = game.get("value") or {}
    moneyline_edge = value.get("edge")
    if moneyline_edge is None:
        moneyline_edge = totals.get("modelEdge") if isinstance(totals, dict) else None
    dashboard_game = {
        "id": game.get("game_id") or game.get("gamePk") or game.get("id"),
        "date": game.get("date"),
        "away_team": game.get("away_team") or (game.get("away") or {}).get("name"),
        "home_team": game.get("home_team") or (game.get("home") or {}).get("name"),
        "game_time": game.get("start") or game.get("startTime"),
        "ballpark": game.get("venue"),
        "status": game.get("status"),
        "probable_pitchers": {
            "away": game.get("starters", {}).get("away", "TBD") if isinstance(game.get("starters"), dict) else "TBD",
            "home": game.get("starters", {}).get("home", "TBD") if isinstance(game.get("starters"), dict) else "TBD",
            "awayEra": game.get("starters", {}).get("awayEra") if isinstance(game.get("starters"), dict) else None,
            "homeEra": game.get("starters", {}).get("homeEra") if isinstance(game.get("starters"), dict) else None,
            "status": quality["probable_pitchers"],
        },
        "lineup_status": quality["lineup"],
        "weather_status": quality["weather"],
        "weather_summary": "Weather adjustment included when available",
        "odds_status": quality["odds"],
        "freshness_status": "Fresh",
        "final_lean": game.get("pick", {}).get("name") or "NO BET",
        "no_bet_reason": "",
        "moneyline": {
            "away_probability": _as_percent(game.get("probabilities", {}).get("away") if isinstance(game.get("probabilities"), dict) else (game.get("away") or {}).get("winProbability")),
            "home_probability": _as_percent(game.get("probabilities", {}).get("home") if isinstance(game.get("probabilities"), dict) else (game.get("home") or {}).get("winProbability")),
            "model_probability": _as_percent(game.get("pick", {}).get("probability") or game.get("pick", {}).get("winProbability")),
            "market_implied_probability": None,
            "edge": _as_edge_pct(moneyline_edge),
            "current_odds": "Unavailable",
            "confidence": _status(game.get("pick", {}).get("confidence"), "Low").title(),
        },
        "data_quality": quality,
        "main_factors": game.get("reasons") or [],
        "risk_factors": [game.get("risk")] if game.get("risk") else quality.get("issues", []),
    }
    predicted_winner, predicted_probability = _winner_from_probabilities(dashboard_game)
    dashboard_game["predicted_winner"] = game.get("pick", {}).get("name") or predicted_winner
    dashboard_game["predicted_winner_probability"] = _as_percent(game.get("pick", {}).get("probability")) or predicted_probability

    # Prefer the bot's own moneyline value engine output (betDecision) over the
    # dashboard's legacy threshold logic, so live cards match the Telegram bot's
    # confidence band + quarter-Kelly sizing instead of a diverged fork.
    value = game.get("value") or None
    if value:
        decision = _decision_from_value(value)
        dashboard_game["confidence_band"] = value.get("confidenceBand")
        dashboard_game["kelly_stake_percent"] = safe_float(value.get("kellyStakePercent"), None)
        dashboard_game["value_status"] = value.get("status")
        dashboard_game["value_reason"] = value.get("reason") or ""
        kelly = dashboard_game["kelly_stake_percent"]
        dashboard_game["moneyline"]["edge"] = _as_edge_pct(value.get("edge"))
        dashboard_game["moneyline"]["confidence"] = str(value.get("confidenceBand") or dashboard_game["moneyline"]["confidence"]).title()
        dashboard_game["decision"] = decision
        dashboard_game["no_bet_reason"] = value.get("reason") or "" if decision == "NO BET" else ""
        dashboard_game["final_lean"] = (
            f"{value.get('teamName')} {_format_odds(value.get('odds'))}".strip()
            if decision != "NO BET" and value.get("teamName")
            else dashboard_game["final_lean"]
        )
        return dashboard_game

    decision, reason = _decision_from_game(dashboard_game, settings)
    if dashboard_game["odds_status"] in {"Unavailable", "Missing"} and decision == "BET":
        decision = "LEAN"
        reason = "Market odds unavailable, treat as lean only"
    dashboard_game["decision"] = decision
    dashboard_game["no_bet_reason"] = reason
    return dashboard_game


def _node_live_predictions(date_ymd: str) -> dict[str, Any]:
    """Call the existing Node live prediction layer and return normalized JSON."""
    script = (
        "import('./src/dashboard.js')"
        ".then(async (m) => { const data = await m.livePredictions(process.env.DASHBOARD_DATE);"
        " console.log(JSON.stringify(data)); })"
        ".catch((error) => { console.error(error.stack || error.message); process.exit(1); });"
    )
    env = os.environ.copy()
    env["DASHBOARD_DATE"] = date_ymd
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=_ROOT_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=70,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "Node live prediction failed").strip())
    return json.loads(result.stdout)


def _live_today(date_ymd: str, settings: dict[str, Any]) -> dict[str, Any]:
    payload = _node_live_predictions(date_ymd)
    games = [_live_game_to_dashboard(game, settings) for game in payload.get("games", [])]
    return _summarize_today(games, "live")


def _quality_from_sample(quality: dict[str, Any]) -> dict[str, Any]:
    return {
        "score": quality.get("score", 0),
        "probable_pitchers": quality.get("probable_pitchers", "Missing"),
        "lineup": quality.get("lineup", "Missing"),
        "weather": quality.get("weather", "Missing"),
        "odds": quality.get("odds", "Missing"),
        "bullpen_usage": quality.get("bullpen_usage", "Missing"),
        "park_factor": quality.get("park_factor", "Missing"),
        "injury_news": quality.get("injury_news", "Missing"),
        "market_movement": quality.get("market_movement", "Missing"),
        "missing_fields": quality.get("missing_fields", []),
        "stale_fields": quality.get("stale_fields", []),
        "confidence_adjustments": quality.get("confidence_adjustments", []),
        "issues": quality.get("missing_fields", []) + quality.get("stale_fields", []),
    }


def _sample_game_to_dashboard(game_id: int, pipeline: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any]:
    game = pipeline["game"]
    moneyline = pipeline["moneyline"]
    quality = _quality_from_sample(pipeline.get("quality_report", {}))
    context = pipeline.get("context", {})
    market = pipeline.get("market", {})
    dashboard_game = {
        "id": str(game_id),
        "date": game.date,
        "away_team": game.away_team,
        "home_team": game.home_team,
        "game_time": game.date,
        "ballpark": context.get("park", {}).get("park", game.home_team),
        "status": "Sample",
        "probable_pitchers": {
            "away": game.away_pitcher or "TBD",
            "home": game.home_pitcher or "TBD",
            "status": quality["probable_pitchers"],
        },
        "lineup_status": quality["lineup"],
        "weather_status": quality["weather"],
        "weather_summary": context.get("weather", {}).get("condition", "Sample weather context"),
        "odds_status": quality["odds"],
        "freshness_status": "Sample",
        "final_lean": moneyline.get("final_lean"),
        "no_bet_reason": moneyline.get("decision_reason") or "",
        "moneyline": {
            "away_probability": _as_percent(moneyline.get("away_win_probability")),
            "home_probability": _as_percent(moneyline.get("home_win_probability")),
            "model_probability": _as_percent(max(moneyline.get("away_win_probability", 0), moneyline.get("home_win_probability", 0))),
            "market_implied_probability": _as_percent(moneyline.get("home_market_implied_probability")),
            "edge": _as_edge_pct(moneyline.get("model_edge")),
            "current_odds": market.get("home_moneyline") or "Unavailable",
            "confidence": str(moneyline.get("confidence", "Low")).title(),
        },
        "data_quality": quality,
        "main_factors": pipeline.get("supporting_factors") or moneyline.get("main_factors") or [],
        "risk_factors": quality.get("issues") or [moneyline.get("decision_reason", "")],
    }
    predicted_winner, predicted_probability = _winner_from_probabilities(dashboard_game)
    dashboard_game["predicted_winner"] = predicted_winner
    dashboard_game["predicted_winner_probability"] = predicted_probability
    decision, reason = _decision_from_game(dashboard_game, settings)
    dashboard_game["decision"] = decision
    dashboard_game["no_bet_reason"] = reason or dashboard_game["no_bet_reason"]
    return dashboard_game


def _sample_today(settings: dict[str, Any]) -> dict[str, Any]:
    games = []
    for game_id in range(0, 8):
        try:
            games.append(_sample_game_to_dashboard(game_id, run_prediction_pipeline(game_id), settings))
        except Exception:
            break
    return _summarize_today(games, "sample")


# Short in-memory cache for the live dashboard payload. The live path runs the
# full Node prediction pipeline (schedule + team/pitcher stats + odds + value
# engine) which takes ~13s for a full slate, so without this every dashboard
# open re-runs it from scratch. Keyed by date; TTL is short enough that odds and
# lineups stay fresh. Override with DASHBOARD_LIVE_CACHE_SECONDS (0 disables).
_LIVE_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}


def _live_cache_ttl_seconds() -> float:
    try:
        return float(os.environ.get("DASHBOARD_LIVE_CACHE_SECONDS", "90"))
    except ValueError:
        return 90.0


def _unavailable_today(reason: str, source: str = "live") -> dict[str, Any]:
    """Explicit failure payload — never synthesize realistic BET/ROI mock as live."""
    return {
        "status": "unavailable",
        "source": source,
        "reason": reason,
        "last_updated": now_iso(),
        "warning": reason,
        "summary": {
            "total_games": 0,
            "bet_count": 0,
            "lean_count": 0,
            "no_bet_count": 0,
            "average_data_quality": None,
        },
        "games": [],
    }


def get_today_dashboard(date_ymd: str | None = None, source: str = "live") -> dict[str, Any]:
    """Return today's dashboard payload from live, sample, or mock data.

    Live failures return status=unavailable (not realistic mock data).
    Mock/sample only when explicitly requested via source=.
    """
    settings = load_dashboard_settings()
    source = (source or "live").lower()
    target_date = date_ymd or datetime.now().date().isoformat()
    if source == "mock":
        return _mock_today(settings)
    if source == "sample":
        return _sample_today(settings)

    ttl = _live_cache_ttl_seconds()
    now = datetime.now(timezone.utc).timestamp()
    if ttl > 0:
        cached = _LIVE_CACHE.get(target_date)
        if cached and (now - cached[0]) < ttl:
            return cached[1]
    try:
        payload = _live_today(target_date, settings)
    except Exception as exc:
        return _unavailable_today(
            f"Live data unavailable: {exc}",
            source="live",
        )
    if ttl > 0:
        _LIVE_CACHE[target_date] = (now, payload)
    return payload


def _telegram_learning_by_game(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
    memory = state.get("memory") or {}
    logs = memory.get("learningLog") or []
    return {str(item.get("gamePk")): item for item in logs if item.get("gamePk") is not None}


def _telegram_history_row(
    prediction: dict[str, Any],
    outcome: dict[str, Any] | None = None,
    ledger_row: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Convert a Telegram prediction without inventing financial facts.

    Win/Loss describes model-pick correctness. BET, stake, P/L, edge, odds and
    CLV are populated only when an authoritative ledger row exists.
    """
    pick = prediction.get("pick") or {}
    away = prediction.get("away") or {}
    home = prediction.get("home") or {}
    correct = outcome.get("correct") if outcome else None
    model_result = "Pending" if correct is None else "Win" if correct else "Loss"
    prediction_name = pick.get("name") or pick.get("abbreviation") or "-"
    probability = safe_float(pick.get("winProbability"), 0.0)

    has_ledger = ledger_row is not None
    ledger_status = str((ledger_row or {}).get("status") or "").lower()
    ledger_result = str((ledger_row or {}).get("result") or "").title()
    decision = "BET" if has_ledger else "PREDICTION"
    if not has_ledger and str((prediction.get("betDecision") or {}).get("status") or "").upper() == "NO BET":
        decision = "NO BET"

    return {
        "date": prediction.get("dateYmd"),
        "game_pk": prediction.get("gamePk"),
        "matchup": prediction.get("matchup") or f"{away.get('name')} @ {home.get('name')}",
        "market_type": str((ledger_row or {}).get("market") or "moneyline"),
        "prediction": prediction_name,
        "decision": decision,
        "confidence": str(pick.get("confidence") or "model").title(),
        "model_probability": probability,
        "market_implied_probability": None,
        "edge": (ledger_row or {}).get("edge"),
        "odds": (ledger_row or {}).get("odds"),
        "units_staked": (ledger_row or {}).get("units_staked"),
        "projected_total": None,
        "market_total": (ledger_row or {}).get("line"),
        "closing_line": None,
        "actual_result": outcome.get("score") if outcome else "",
        "result": ledger_result if ledger_status == "settled" and ledger_result else model_result,
        "model_result": model_result,
        "profit_loss": (ledger_row or {}).get("units_pl"),
        "clv": (ledger_row or {}).get("clv"),
        "notes": outcome.get("note", "") if outcome else prediction.get("agentRisk", ""),
        "source": "telegram+ledger" if has_ledger else "telegram_prediction_only",
        "financial_status": ledger_status or "unavailable",
    }


def get_telegram_prediction_history() -> list[dict[str, Any]]:
    """Return Telegram prediction rows joined to authoritative ledger by game."""
    state = load_telegram_state()
    predictions = state.get("predictions") or {}
    outcomes = _telegram_learning_by_game(state)
    ledger = get_bet_ledger()
    ledger_rows = list(ledger.get("open") or []) + list(ledger.get("settled") or [])
    moneyline_by_game = {
        str(row.get("game_pk")): row
        for row in ledger_rows
        if str(row.get("market") or "moneyline").lower() == "moneyline"
        and row.get("game_pk") is not None
    }
    rows = [
        _telegram_history_row(
            prediction,
            outcomes.get(str(game_pk)),
            moneyline_by_game.get(str(game_pk)),
        )
        for game_pk, prediction in predictions.items()
    ]
    rows.sort(key=lambda row: (str(row.get("date") or ""), str(row.get("matchup") or "")), reverse=True)
    return rows


def _accuracy(correct: Any, total: Any) -> float:
    parsed_total = safe_float(total, 0.0)
    if parsed_total <= 0:
        return 0.0
    return round((safe_float(correct, 0.0) / parsed_total) * 100.0, 1)


def _rolling_win_rate(learning_log: list[dict[str, Any]], days: int = 3) -> dict[str, Any] | None:
    """Win rate over the last `days` from the Telegram learning log.

    Mirrors the bot's /postgame rolling rate so recent form (which can differ a
    lot from the all-time baseline) is visible on the dashboard too.
    """
    if not learning_log:
        return None
    cutoff = datetime.now(timezone.utc).timestamp() - days * 86400
    correct = 0
    total = 0
    for entry in learning_log:
        at = entry.get("at")
        if not at or not isinstance(entry.get("correct"), bool):
            continue
        try:
            stamp = datetime.fromisoformat(str(at).replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        if stamp < cutoff:
            continue
        total += 1
        if entry.get("correct"):
            correct += 1
    if total == 0:
        return None
    return {"days": days, "wins": correct, "total": total, "win_rate": _accuracy(correct, total)}



def _telegram_calibration_rows(state: dict[str, Any]) -> list[dict[str, Any]]:
    predictions = state.get("predictions") or {}
    outcomes = _telegram_learning_by_game(state)
    buckets: dict[str, dict[str, float]] = {}
    for game_pk, prediction in predictions.items():
        outcome = outcomes.get(str(game_pk))
        if outcome is None:
            continue
        probability = safe_float((prediction.get("pick") or {}).get("winProbability"), 0.0)
        if probability <= 0:
            continue
        bucket_floor = int(probability // 10) * 10
        bucket = f"{bucket_floor}-{bucket_floor + 9}%"
        if bucket not in buckets:
            buckets[bucket] = {"predictions": 0, "expected": 0.0, "correct": 0.0}
        buckets[bucket]["predictions"] += 1
        buckets[bucket]["expected"] += probability
        buckets[bucket]["correct"] += 1 if outcome.get("correct") else 0

    return [
        {
            "bucket": bucket,
            "predictions": int(values["predictions"]),
            "expected": round(values["expected"] / values["predictions"], 1) if values["predictions"] else 0.0,
            "actual": _accuracy(values["correct"], values["predictions"]),
        }
        for bucket, values in sorted(buckets.items())
    ]


def _normalize_probability(value: Any) -> float | None:
    probability = safe_float(value, float("nan"))
    if probability != probability:
        return None
    if abs(probability) > 1.0:
        probability /= 100.0
    return max(0.0, min(1.0, probability))


def _settled_ledger_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in rows if row.get("status") == "settled"]


def _scored_ledger_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in rows if str(row.get("result") or "").lower() in {"win", "loss"}]


def _ledger_financial_metrics(rows: list[dict[str, Any]]) -> dict[str, float]:
    staked = sum(safe_float(row.get("units_staked"), 0.0) for row in rows)
    units_pl = sum(safe_float(row.get("units_pl"), 0.0) for row in rows)
    clv_values = [safe_float(row.get("clv"), 0.0) for row in rows if row.get("clv") not in (None, "")]
    edges = [safe_float(row.get("edge"), 0.0) for row in rows if row.get("edge") not in (None, "")]
    probability_pairs = [
        (probability, 1 if str(row.get("result") or "").lower() == "win" else 0)
        for row in _scored_ledger_rows(rows)
        for probability in [_normalize_probability(row.get("model_prob"))]
        if probability is not None
    ]
    probabilities = [probability for probability, _ in probability_pairs]
    outcomes = [outcome for _, outcome in probability_pairs]
    return {
        "roi": round((units_pl / staked) * 100.0, 1) if staked > 0 else 0.0,
        "average_edge": round(sum(edges) / len(edges), 3) if edges else 0.0,
        "average_clv": round(sum(clv_values) / len(clv_values), 3) if clv_values else 0.0,
        "clv_hit_rate": round((sum(1 for value in clv_values if value > 0) / len(clv_values)) * 100.0, 1) if clv_values else 0.0,
        "brier_score": round(brier_score(probabilities, outcomes), 4) if probability_pairs else 0.0,
        "log_loss": round(log_loss(probabilities, outcomes), 4) if probability_pairs else 0.0,
    }


def get_telegram_model_performance() -> dict[str, Any] | None:
    """Return model performance from Telegram memory so it matches /memory."""
    state = load_telegram_state()
    memory = state.get("memory") or {}
    total = safe_float(memory.get("totalPicks"), 0.0)
    if total <= 0:
        return None

    correct = safe_float(memory.get("correctPicks"), 0.0)
    wrong = safe_float(memory.get("wrongPicks"), 0.0)
    win_rate = _accuracy(correct, total)
    learning_log = memory.get("learningLog") or []
    rolling_3d = _rolling_win_rate(learning_log, days=3)
    by_confidence = memory.get("byConfidence") or {}
    calibration = _telegram_calibration_rows(state)
    if not calibration:
        calibration = [
            {
                "bucket": str(label).title(),
                "predictions": int(value.get("total", 0)),
                "expected": 0.0,
                "actual": _accuracy(value.get("correct", 0), value.get("total", 0)),
            }
            for label, value in by_confidence.items()
        ]

    ledger = get_bet_ledger()
    settled_ledger = _settled_ledger_rows(ledger.get("settled") or [])
    moneyline_rows = [row for row in settled_ledger if str(row.get("market") or "moneyline").lower() == "moneyline"]
    ledger_metrics = _ledger_financial_metrics(moneyline_rows) if moneyline_rows else None

    return {
        "overall": {
            "total_predictions": int(total),
            "bets_taken": len(moneyline_rows),
            "wins": int(correct),
            "losses": int(wrong),
            "win_rate": win_rate,
            "win_rate_3d": rolling_3d.get("win_rate") if rolling_3d else None,
            "win_rate_3d_sample": f"{rolling_3d['wins']}/{rolling_3d['total']}" if rolling_3d else None,
            "roi": ledger_metrics["roi"] if ledger_metrics else None,
            "average_edge": ledger_metrics["average_edge"] if ledger_metrics else None,
            "average_clv": ledger_metrics["average_clv"] if ledger_metrics else None,
            "brier_score": ledger_metrics["brier_score"] if ledger_metrics else None,
            "log_loss": ledger_metrics["log_loss"] if ledger_metrics else None,
            "clv_hit_rate": ledger_metrics["clv_hit_rate"] if ledger_metrics else None,
            "source": "telegram+ledger" if ledger_metrics else "telegram_prediction_only",
        },
        "by_market": [
            {"market": "moneyline", "bets": len(moneyline_rows), "win_rate": win_rate, "roi": ledger_metrics["roi"] if ledger_metrics else None},
        ],
        "by_total_range": [],
        "calibration": calibration,
        "recent_log": (memory.get("learningLog") or [])[:10],
    }


def get_bet_ledger() -> dict[str, Any]:
    """Return the bet ledger (open + settled bets) from state.sqlite.

    Mirrors src/ledgerReport.js: fixed-notional bankroll where units_staked is a
    percentage of bankroll that doubles as units, and ROI is stake-weighted
    (total P/L over total staked). Read-only; returns an empty ledger when the
    SQLite database or bet_ledger table is unavailable.
    """
    empty = {
        "bankroll_units": 100,
        "open": [],
        "settled": [],
        "summary": {
            "open_count": 0,
            "settled_count": 0,
            "wins": 0,
            "losses": 0,
            "pushes": 0,
            "record": "0-0",
            "units_staked": 0.0,
            "units_pl": 0.0,
            "roi": 0.0,
        },
        "by_market": [],
    }
    if not _SQLITE_PATH.exists():
        return empty

    try:
        conn = sqlite3.connect(str(_SQLITE_PATH))
        conn.row_factory = sqlite3.Row
        try:
            rows = [dict(row) for row in conn.execute(
                "SELECT * FROM bet_ledger ORDER BY date_ymd ASC, decision_id ASC"
            )]
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logging.warning("Failed to read bet ledger from SQLite: %s", exc)
        return empty

    open_rows = [r for r in rows if r.get("status") == "open"]
    settled_rows = [r for r in rows if r.get("status") == "settled"]

    wins = sum(1 for r in settled_rows if r.get("result") == "win")
    losses = sum(1 for r in settled_rows if r.get("result") == "loss")
    pushes = sum(1 for r in settled_rows if r.get("result") == "push")
    staked = sum(safe_float(r.get("units_staked"), 0.0) for r in settled_rows)
    units_pl = sum(safe_float(r.get("units_pl"), 0.0) for r in settled_rows)
    roi = round((units_pl / staked) * 100.0, 1) if staked > 0 else 0.0

    record = f"{wins}-{losses}" + (f"-{pushes}P" if pushes else "")

    by_market: dict[str, dict[str, float]] = {}
    for r in settled_rows:
        market = str(r.get("market") or "moneyline")
        bucket = by_market.setdefault(market, {"units_staked": 0.0, "units_pl": 0.0, "bets": 0})
        bucket["units_staked"] += safe_float(r.get("units_staked"), 0.0)
        bucket["units_pl"] += safe_float(r.get("units_pl"), 0.0)
        bucket["bets"] += 1

    return {
        "bankroll_units": 100,
        "open": open_rows,
        "settled": settled_rows,
        "summary": {
            "open_count": len(open_rows),
            "settled_count": len(settled_rows),
            "wins": wins,
            "losses": losses,
            "pushes": pushes,
            "record": record,
            "units_staked": round(staked, 2),
            "units_pl": round(units_pl, 2),
            "roi": roi,
        },
        "by_market": [
            {
                "market": market,
                "bets": int(bucket["bets"]),
                "units_staked": round(bucket["units_staked"], 2),
                "units_pl": round(bucket["units_pl"], 2),
                "roi": round((bucket["units_pl"] / bucket["units_staked"]) * 100.0, 1)
                if bucket["units_staked"] > 0
                else 0.0,
            }
            for market, bucket in sorted(by_market.items())
        ],
    }


def get_prediction_history() -> list[dict[str, Any]]:
    """Return historical predictions from the log or mock data."""
    telegram_rows = get_telegram_prediction_history()
    if telegram_rows:
        return telegram_rows

    rows = load_prediction_log()
    if not rows:
        return load_mock_dashboard().get("history", [])
    history = []
    for row in rows:
        prediction = row.get("final_lean") or row.get("predicted_winner")
        history.append(
            {
                "date": row.get("date"),
                "matchup": f"{row.get('away_team')} @ {row.get('home_team')}",
                "market_type": "moneyline",
                "prediction": prediction,
                "decision": "NO BET" if prediction == "NO BET" else "BET",
                "confidence": str(row.get("confidence", "")).title(),
                "model_probability": _as_percent(row.get("home_win_probability") or row.get("over_probability")),
                "market_implied_probability": None,
                "edge": _as_edge_pct(row.get("model_edge")),
                "projected_total": row.get("projected_total_runs"),
                "market_total": row.get("market_total"),
                "closing_line": row.get("closing_line"),
                "actual_result": f"{row.get('away_team')} {row.get('actual_away_score')} - {row.get('home_team')} {row.get('actual_home_score')}",
                "result": str(row.get("result", "")).title(),
                "profit_loss": safe_float(row.get("profit_loss"), 0.0),
                "clv": safe_float(row.get("closing_line_value"), 0.0),
                "notes": "",
            }
        )
    return history


def get_model_performance() -> dict[str, Any]:
    """Return performance metrics from prediction logs or mock data."""
    telegram_performance = get_telegram_model_performance()
    if telegram_performance:
        return telegram_performance

    rows = load_prediction_log()
    if not rows:
        return load_mock_dashboard().get("performance", {})
    metrics = calculate_metrics(rows)
    by_confidence = performance_by_confidence(rows)
    by_total_range = performance_by_market_total(rows)
    return {
        "overall": {
            "total_predictions": len(rows),
            "bets_taken": metrics.get("bets", 0),
            "win_rate": _as_percent(metrics.get("win_rate")) or 0.0,
            "roi": _as_edge_pct(metrics.get("roi")) or 0.0,
            "average_edge": _as_edge_pct(metrics.get("average_edge")) or 0.0,
            "average_clv": metrics.get("average_clv", 0.0),
            "brier_score": metrics.get("brier_score", 0.0),
            "log_loss": metrics.get("log_loss", 0.0),
            "clv_hit_rate": 0.0,
        },
        "by_market": [
            {"market": "moneyline", "bets": metrics.get("bets", 0), "win_rate": _as_percent(metrics.get("win_rate")) or 0.0, "roi": _as_edge_pct(metrics.get("roi")) or 0.0},
                    ],
        "by_total_range": [
            {"range": key, "bets": value.get("bets", 0), "win_rate": _as_percent(value.get("win_rate")) or 0.0, "roi": _as_edge_pct(value.get("roi")) or 0.0}
            for key, value in by_total_range.items()
        ],
        "calibration": [
            {"bucket": key, "predictions": value.get("bets", 0), "expected": 0.0, "actual": _as_percent(value.get("win_rate")) or 0.0}
            for key, value in by_confidence.items()
        ],
    }


def get_evolution_dashboard(limit: int = 20) -> dict[str, Any]:
    """Return read-only evolution engine state for the dashboard."""
    from .evolution.evolution_report import build_evolution_summary

    return build_evolution_summary(limit=limit)


def _json_tail(payload: dict[str, Any], limit: int = 2000) -> str:
    """Return a compact dashboard-friendly JSON output snippet."""
    text = json.dumps(payload, indent=2, default=str)
    return text[-limit:] if len(text) > limit else text


def run_evolve_cycle() -> dict[str, Any]:
    """Run the full evolution pipeline: cycle (backfill + ingest + calibration +
    candidates) followed by a safe-apply audit. Mirrors the bot's single
    /evolve command so the dashboard button does everything in one click.
    """
    try:
        from .evolution.evolution_audit import build_evolution_audit
        from .evolution.evolution_engine import run_evolution_cycle as run_engine_evolution_cycle

        cycle = run_engine_evolution_cycle()
        audit = build_evolution_audit(
            min_segment_sample=3,
            candidate_limit=10,
            persist=True,
            apply_safe=True,
            update_memory=True,
        )
        result = {**cycle, "audit": audit}
        return {
            **result,
            "status": "ok",
            "result": result,
            "output": _json_tail(result),
            "detail": "",
        }
    except Exception as exc:
        return {"status": "error", "output": "", "detail": str(exc)}


def run_audit_cycle() -> dict[str, Any]:
    """Backwards-compatible alias. The dashboard now runs one consolidated
    pipeline, so /api/audit performs the same full evolve cycle + audit.
    """
    return run_evolve_cycle()


def _history_backtest_rows(params: dict[str, Any], market: str) -> list[dict[str, Any]]:
    """Replay the real settled-prediction history for one market, filtered by
    the requested date window.

    The dashboard backtest used to replay ``data/sample_games.csv`` — a tiny
    static fixture — so every date range produced identical numbers. This reads
    the canonical ``prediction_outcomes.csv`` instead and shapes each row into
    the schema ``calculate_metrics``/``calibration_rows`` expect.
    """
    from .evolution.memory_store import read_prediction_outcomes

    start_date = params.get("start_date") or None
    end_date = params.get("end_date") or None

    rows: list[dict[str, Any]] = []
    for outcome in read_prediction_outcomes():
        if str(outcome.get("market") or "").lower() != market:
            continue
        date = str(outcome.get("date") or "")
        if start_date and date < start_date:
            continue
        if end_date and date > end_date:
            continue

        evaluation = _safe_evaluation(outcome.get("evaluation_json"))
        result = str(outcome.get("result") or "").lower()
        # predicted_probability is stored 0-100 for the PICKED side; metrics
        # helpers work on a 0-1 scale, so normalize. Older rows (pre-calibration)
        # left it blank but carry an authoritative brier_score column, so
        # reconstruct the probability from brier the same way the calibrator
        # does — otherwise row_probability() defaults to 0 and inflates brier.
        predicted = safe_float(evaluation.get("predicted_probability"), None)
        if predicted is not None and predicted > 1.0:
            probability = predicted / 100.0
        elif predicted is not None:
            probability = predicted
        else:
            brier = safe_float(outcome.get("brier_score"), None)
            if brier is not None and result in ("win", "loss"):
                root = max(0.0, brier) ** 0.5
                probability = (1.0 - root) if result == "win" else root
            else:
                probability = None
        lean = str(outcome.get("prediction") or "")
        actual_winner = evaluation.get("actual_winner")
        # The outcomes CSV stores only the picked side, not both team names.
        # Use the pick as home_team so row_probability() resolves the moneyline
        # probability via the home field; surface the opponent when known.
        opponent = actual_winner if actual_winner and actual_winner != lean else ""

        shaped: dict[str, Any] = {
            "date": date,
            "away_team": opponent,
            "home_team": lean,
            "final_lean": lean,
            "result": result,
            "profit_loss": safe_float(outcome.get("profit_loss"), 0.0),
            "model_edge": safe_float(evaluation.get("edge"), 0.0),
            "closing_line_value": safe_float(outcome.get("clv"), 0.0),
            "confidence": outcome.get("confidence") or evaluation.get("confidence"),
            "market_total": evaluation.get("market_total"),
        }
        # Attach the calibrated/predicted probability to the field that
        # row_probability() reads for this lean type.
        if probability is not None:
            if lean.startswith("Over"):
                shaped["over_probability"] = probability
            elif lean.startswith("Under"):
                shaped["under_probability"] = probability
            else:
                shaped["home_win_probability"] = probability
        rows.append(shaped)

    return rows


def _safe_evaluation(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, json.JSONDecodeError):
        return {}


def _dashboard_backtest_rows(params: dict[str, Any], market: str) -> list[dict[str, Any]]:
    return _history_backtest_rows(params, market)


def _camel_backtest_summary(metrics: dict[str, Any]) -> dict[str, Any]:
    return {
        "totalBets": metrics.get("bets", 0),
        "winRate": round(_as_percent(metrics.get("win_rate")) or 0.0, 1),
        "roi": round(_as_edge_pct(metrics.get("roi")) or 0.0, 1),
        "clv": round(_as_edge_pct(metrics.get("average_clv")) or 0.0, 1),
        "brier": round(safe_float(metrics.get("brier_score"), 0.0), 3),
    }


def run_dashboard_backtest(params: dict[str, Any]) -> dict[str, Any]:
    """Replay real settled-prediction history for the selected market and date
    window, shaped for the dashboard. Reads prediction_outcomes.csv (not the
    static sample), so different date ranges yield different numbers.
    """
    requested_market = params.get("market_type") or params.get("market") or "moneyline"
    market_map = {
        "moneyline": ["moneyline"],
        "all": ["moneyline"],
    }
    markets = market_map.get(requested_market)
    if not markets:
        supported = ", ".join(sorted(market_map))
        raise ValueError(f"market must be one of: {supported}")

    tagged_rows: list[dict[str, Any]] = []
    for market in markets:
        tagged_rows.extend({**row, "dashboard_market": market} for row in _dashboard_backtest_rows(params, market))

    if not tagged_rows:
        empty_metrics = calculate_metrics([])
        return {
            "summary": {
                "bets_taken": 0,
                "win_rate": 0.0,
                "roi": 0.0,
                "average_edge": 0.0,
                "average_clv": 0.0,
                "best_segment": "No rows in selected window",
                "weakest_segment": "No rows in selected window",
                "calibration_summary": "No settled bets in selected window.",
                "no_bet_count": 0,
                **_camel_backtest_summary(empty_metrics),
            },
            "byMarket": [
                {"market": market.title(), "bets": 0, "winRate": 0.0, "roi": 0.0}
                for market in markets
            ],
            "calibration": [],
            "no_bet_reasons": [],
            "rows": [],
        }

    metrics = calculate_metrics(tagged_rows)
    no_bet_reasons: dict[str, int] = {}
    for row in tagged_rows:
        if row.get("result") == "no_bet":
            reason = row.get("final_lean") or "NO BET"
            no_bet_reasons[reason] = no_bet_reasons.get(reason, 0) + 1

    by_market = []
    for market in markets:
        market_rows = [row for row in tagged_rows if row.get("dashboard_market") == market]
        market_metrics = calculate_metrics(market_rows)
        by_market.append(
            {
                "market": market.title(),
                "bets": market_metrics.get("bets", 0),
                "winRate": round(_as_percent(market_metrics.get("win_rate")) or 0.0, 1),
                "roi": round(_as_edge_pct(market_metrics.get("roi")) or 0.0, 1),
            }
        )

    calibration = [
        {
            "bucket": row["bucket"],
            "count": row["count"],
            "predicted": round(_as_percent(row["avg_probability"]) or 0.0, 1),
            "actual": round(_as_percent(row["actual_rate"]) or 0.0, 1),
        }
        for row in calibration_table(calibration_rows(tagged_rows))
    ]

    summary = {
        "bets_taken": metrics.get("bets", 0),
        "win_rate": _as_percent(metrics.get("win_rate")) or 0.0,
        "roi": _as_edge_pct(metrics.get("roi")) or 0.0,
        "average_edge": _as_edge_pct(metrics.get("average_edge")) or 0.0,
        "average_clv": metrics.get("average_clv", 0.0),
        "best_segment": "See performance by market total",
        "weakest_segment": "See performance by market total",
        "calibration_summary": "Generated from local CSV backtest.",
        "no_bet_count": sum(1 for row in tagged_rows if row.get("result") == "no_bet"),
        **_camel_backtest_summary(metrics),
    }
    return {
        "summary": summary,
        "byMarket": by_market,
        "calibration": calibration,
        "no_bet_reasons": [{"reason": key, "count": value} for key, value in no_bet_reasons.items()],
        "rows": [
            {
                "date": row.get("date"),
                "matchup": f"{row.get('away_team')} @ {row.get('home_team')}",
                "market": row.get("dashboard_market"),
                "lean": row.get("final_lean"),
                "result": row.get("result"),
                "edge": _as_edge_pct(row.get("model_edge")),
                "profit_loss": row.get("profit_loss"),
            }
            for row in tagged_rows
        ],
    }


def get_mock_backtest() -> dict[str, Any]:
    """Return mock backtest payload."""
    return load_mock_dashboard().get("backtest", {})


def rows_to_csv(rows: list[dict[str, Any]]) -> str:
    """Serialize dictionaries to CSV text."""
    if not rows:
        return ""
    fieldnames = sorted({key for row in rows for key in row.keys()})
    output = StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return output.getvalue()
