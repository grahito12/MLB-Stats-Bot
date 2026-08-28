"""FastAPI backend for the React MLB prediction control center."""

from __future__ import annotations

import os
import secrets
import sys
import time
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .prediction_audit import get_prediction_audit, list_audit_predictions
from .dashboard_service import (
    get_mock_backtest,
    get_bet_ledger,
    get_evolution_dashboard,
    get_health_status,
    get_model_performance,
    get_prediction_history,
    get_today_dashboard,
    load_dashboard_settings,
    rows_to_csv,
    run_audit_cycle,
    run_dashboard_backtest,
    run_evolve_cycle,
    save_dashboard_settings,
)


ROOT_DIR = Path(__file__).resolve().parents[1]
_RATE_LIMIT_STATE: dict[str, list[float]] = {}


class BacktestRequest(BaseModel):
    """Backtest request from the dashboard UI."""

    season: int | None = None
    start_date: str | None = None
    end_date: str | None = None
    market_type: str = "moneyline"


def request_payload(request: BacktestRequest) -> dict[str, Any]:
    """Support Pydantic v1 and v2 request serialization."""
    if hasattr(request, "model_dump"):
        return request.model_dump()
    return request.dict()


def load_dotenv(path: Path = ROOT_DIR / ".env") -> None:
    if not path.exists():
        return

    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def csv_env(name: str, fallback: list[str]) -> list[str]:
    """Read a comma-separated env var while keeping local-only defaults."""
    value = os.environ.get(name, "")
    if not value:
        return fallback
    return [item.strip() for item in value.split(",") if item.strip()]


def clear_rate_limit_state() -> None:
    """Clear in-memory API rate limit counters for tests and restarts."""
    _RATE_LIMIT_STATE.clear()


def dashboard_rate_limit_per_minute() -> int:
    """Return the per-client dashboard API rate limit."""
    try:
        return int(os.environ.get("DASHBOARD_RATE_LIMIT_PER_MINUTE", "120"))
    except ValueError:
        return 120


def _client_rate_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    host = forwarded or (request.client.host if request.client else "unknown")
    return f"{host}:{request.url.path}"


def rate_limit_exceeded(key: str, now: float | None = None) -> bool:
    """Return True when a rate limit key has exhausted its request window."""
    limit = dashboard_rate_limit_per_minute()
    if limit <= 0:
        return False

    current = time.monotonic() if now is None else now
    window_start = current - 60.0
    hits = [timestamp for timestamp in _RATE_LIMIT_STATE.get(key, []) if timestamp >= window_start]
    if len(hits) >= limit:
        _RATE_LIMIT_STATE[key] = hits
        return True
    hits.append(current)
    _RATE_LIMIT_STATE[key] = hits
    return False


def dashboard_api_token() -> str:
    """Return the configured dashboard bearer token, if any."""
    return os.environ.get("DASHBOARD_API_TOKEN", "").strip()


def ensure_dashboard_token_in_production() -> None:
    """Fail fast when the production dashboard API would start without auth."""
    node_env = os.environ.get("NODE_ENV", "").strip().lower()
    if node_env == "production" and not dashboard_api_token():
        message = "DASHBOARD_API_TOKEN must be set in production"
        print(message, file=sys.stderr)
        raise RuntimeError(message)


def verify_token(request: Request) -> None:
    """Require Authorization: Bearer <token> on API routes when configured."""
    expected = dashboard_api_token()
    if not expected:
        return

    authorization = request.headers.get("authorization", "")
    scheme, _, supplied = authorization.partition(" ")
    supplied = supplied.strip()

    if scheme.lower() != "bearer" or not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=401,
            detail="Invalid dashboard API token",
            headers={"WWW-Authenticate": "Bearer"},
        )


load_dotenv()
ensure_dashboard_token_in_production()
API_DEPENDENCIES = [Depends(verify_token)]

app = FastAPI(
    title="MLB Stats Bot Dashboard API",
    version="0.2.0",
    description="Prediction control-center API for MLB moneyline, quality, and performance.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=csv_env("DASHBOARD_CORS_ORIGINS", ["http://localhost:5173", "http://127.0.0.1:5173"]),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
def health() -> dict[str, Any]:
    """Health check used by local dev and VPS monitoring."""
    return get_health_status()


@app.middleware("http")
async def dashboard_rate_limit(request: Request, call_next):
    """Apply a small in-memory rate limit to authenticated API routes."""
    if not request.url.path.startswith("/api/"):
        return await call_next(request)

    limit = dashboard_rate_limit_per_minute()
    if limit <= 0:
        return await call_next(request)

    key = _client_rate_key(request)
    if rate_limit_exceeded(key):
        return JSONResponse(
            status_code=429,
            content={"detail": f"Dashboard API rate limit exceeded ({limit}/minute)"},
            headers={"Retry-After": "60"},
        )

    return await call_next(request)


@app.get("/api/settings", dependencies=API_DEPENDENCIES)
def api_settings() -> dict[str, Any]:
    """Return dashboard thresholds and toggles."""
    return load_dashboard_settings()


@app.put("/api/settings", dependencies=API_DEPENDENCIES)
def api_update_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Update dashboard thresholds and toggles."""
    return save_dashboard_settings(settings)


@app.get("/api/today", dependencies=API_DEPENDENCIES)
def api_today(date: str | None = None, source: str = "live") -> dict[str, Any]:
    """Return today's games, predictions, market comparison, and quality reports."""
    return get_today_dashboard(date_ymd=date, source=source)


@app.get("/api/history", dependencies=API_DEPENDENCIES)
def api_history() -> dict[str, Any]:
    """Return historical prediction rows."""
    return {"rows": get_prediction_history()}


@app.get("/api/performance", dependencies=API_DEPENDENCIES)
def api_performance() -> dict[str, Any]:
    """Return model performance and calibration summaries."""
    return get_model_performance()


@app.get("/api/ledger", dependencies=API_DEPENDENCIES)
def api_ledger() -> dict[str, Any]:
    """Return the bet ledger: open + settled VALUE bets at quarter-Kelly stakes."""
    return get_bet_ledger()


@app.get("/api/evolution", dependencies=API_DEPENDENCIES)
def api_evolution(limit: int = 20) -> dict[str, Any]:
    """Return read-only evolution engine summaries for the dashboard."""
    return get_evolution_dashboard(limit=limit)


@app.post("/api/evolve", dependencies=API_DEPENDENCIES)
def api_evolve() -> dict[str, Any]:
    """Run the full evolution cycle (evaluate, learn, propose, backtest)."""
    return run_evolve_cycle()


@app.post("/api/audit", dependencies=API_DEPENDENCIES)
def api_audit() -> dict[str, Any]:
    """Run ingest + audit pipeline (learn from history, apply safe guardrails)."""
    return run_audit_cycle()


@app.get("/api/predictions/audit", dependencies=API_DEPENDENCIES)
def api_audit_predictions(date: str | None = None, limit: int = 50) -> dict[str, Any]:
    """List immutable model predictions for the Prediction Audit Card selector."""
    return list_audit_predictions(date_ymd=date, limit=limit)


@app.get("/api/predictions/{prediction_id}/audit", dependencies=API_DEPENDENCIES)
def api_prediction_audit(prediction_id: str) -> dict[str, Any]:
    """Return the normalized audit payload for one immutable prediction."""
    payload = get_prediction_audit(prediction_id)
    if payload is None:
        raise HTTPException(status_code=404, detail=f"Prediction {prediction_id} not found")
    return payload


@app.post("/api/backtest", dependencies=API_DEPENDENCIES)
def api_backtest(request: BacktestRequest) -> dict[str, Any]:
    """Run a local CSV backtest for the selected market and date range."""
    return run_dashboard_backtest(request_payload(request))


@app.get("/api/backtest/mock", dependencies=API_DEPENDENCIES)
def api_backtest_mock() -> dict[str, Any]:
    """Return mock backtest results for frontend development."""
    return get_mock_backtest()


def _csv_response(filename: str, text: str) -> Response:
    return Response(
        text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/export/today", dependencies=API_DEPENDENCIES)
def export_today(date: str | None = None, source: str = "live") -> Response:
    """Export today's prediction cards as CSV."""
    payload = get_today_dashboard(date_ymd=date, source=source)
    return _csv_response("today_predictions.csv", rows_to_csv(payload.get("games", [])))


@app.get("/api/export/history", dependencies=API_DEPENDENCIES)
def export_history() -> Response:
    """Export prediction history as CSV."""
    return _csv_response("prediction_history.csv", rows_to_csv(get_prediction_history()))


@app.get("/api/export/performance", dependencies=API_DEPENDENCIES)
def export_performance() -> Response:
    """Export model performance sections as CSV-friendly rows."""
    performance = get_model_performance()
    rows = [performance.get("overall", {})]
    rows.extend(performance.get("by_market", []))
    rows.extend(performance.get("by_total_range", []))
    rows.extend(performance.get("calibration", []))
    return _csv_response("model_performance.csv", rows_to_csv(rows))


@app.post("/api/export/backtest", dependencies=API_DEPENDENCIES)
def export_backtest(request: BacktestRequest) -> Response:
    """Run and export a backtest result table."""
    payload = run_dashboard_backtest(request_payload(request))
    return _csv_response("backtest_results.csv", rows_to_csv(payload.get("rows", [])))


@app.get("/api/export/backtest", dependencies=API_DEPENDENCIES)
def export_backtest_default(
    season: int | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    market_type: str = "moneyline",
) -> Response:
    """Export a backtest for simple browser downloads."""
    payload = run_dashboard_backtest(
        {
            "season": season,
            "start_date": start_date,
            "end_date": end_date,
            "market_type": market_type,
        }
    )
    return _csv_response("backtest_results.csv", rows_to_csv(payload.get("rows", [])))
