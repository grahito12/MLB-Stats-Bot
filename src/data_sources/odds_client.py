"""Optional The Odds API client for MLB betting markets."""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from typing import Any

from ..env import load_dotenv
from ..odds import american_odds_to_implied_probability, calculate_edge
from .cache import LocalCache

THE_ODDS_API_BASE_URL = "https://api.the-odds-api.com/v4"


class OddsApiClient:
    """Cached adapter for The Odds API.

    The API key is optional. If it is absent, methods return empty payloads so
    local CSV predictions still work.
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = THE_ODDS_API_BASE_URL,
        cache: LocalCache | None = None,
        timeout_seconds: int = 20,
    ) -> None:
        load_dotenv()
        self.api_key = api_key or os.getenv("ODDS_API_KEY") or os.getenv("THE_ODDS_API_KEY") or ""
        self.base_url = base_url.rstrip("/")
        self.cache = cache or LocalCache(ttl_seconds=180)
        self.timeout_seconds = timeout_seconds

    @property
    def configured(self) -> bool:
        """Return whether the client has an API key."""
        return bool(self.api_key)

    def _get(self, path: str, params: dict[str, Any]) -> Any:
        if not self.configured:
            return []
        query = urllib.parse.urlencode({**params, "apiKey": self.api_key})
        url = f"{self.base_url}{path}?{query}"

        def fetch() -> Any:
            request = urllib.request.Request(url, headers={"User-Agent": "mlb-stats-bot/odds"})
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))

        return self.cache.get_or_set_json("the_odds_api", url, fetch)

    def get_mlb_odds(
        self,
        regions: str = "us",
        markets: str = "h2h,spreads,totals",
        odds_format: str = "american",
    ) -> list[dict[str, Any]]:
        """Return current MLB moneyline, run line, and totals markets."""
        return self._get(
            "/sports/baseball_mlb/odds",
            {
                "regions": regions,
                "markets": markets,
                "oddsFormat": odds_format,
            },
        )

    def event_odds(
        self,
        event_id: str,
        regions: str = "us",
        markets: str = "h2h,spreads,totals",
        odds_format: str = "american",
    ) -> dict[str, Any] | list[Any]:
        """Return odds for a single Odds API event id."""
        return self._get(
            f"/sports/baseball_mlb/events/{event_id}/odds",
            {
                "regions": regions,
                "markets": markets,
                "oddsFormat": odds_format,
            },
        )


def extract_market_snapshot(event: dict[str, Any]) -> dict[str, Any]:
    """Extract moneyline, run-line, and total snapshots from an Odds API event."""
    snapshot: dict[str, Any] = {
        "event_id": event.get("id"),
        "home_team": event.get("home_team"),
        "away_team": event.get("away_team"),
        "moneyline": {},
        "run_line": {},
        "totals": {},
    }
    for bookmaker in event.get("bookmakers", []):
        for market in bookmaker.get("markets", []):
            key = market.get("key")
            outcomes = market.get("outcomes", [])
            if key == "h2h":
                for outcome in outcomes:
                    snapshot["moneyline"][outcome.get("name")] = outcome.get("price")
            if key == "spreads":
                for outcome in outcomes:
                    snapshot["run_line"][outcome.get("name")] = {
                        "price": outcome.get("price"),
                        "point": outcome.get("point"),
                    }
            if key == "totals":
                for outcome in outcomes:
                    name = str(outcome.get("name", "")).lower()
                    snapshot["totals"][name] = {
                        "price": outcome.get("price"),
                        "point": outcome.get("point"),
                    }
    return snapshot


def moneyline_edge(model_probability: float, american_odds: str | int | float) -> float:
    """Return model edge over market implied probability."""
    return calculate_edge(model_probability, american_odds_to_implied_probability(str(american_odds)))
