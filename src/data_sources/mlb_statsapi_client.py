"""MLB Stats API client with local caching.

This uses the public MLB Stats API directly so the project does not require a
third-party wrapper. If a wrapper is added later, this client can stay as the
stable adapter used by the rest of the agent.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Any

from .cache import LocalCache

MLB_STATS_API_BASE_URL = "https://statsapi.mlb.com/api/v1"


class MlbStatsApiClient:
    """Minimal MLB Stats API adapter for schedules, teams, players, and games."""

    def __init__(
        self,
        base_url: str = MLB_STATS_API_BASE_URL,
        cache: LocalCache | None = None,
        timeout_seconds: int = 20,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.cache = cache or LocalCache(ttl_seconds=300)
        self.timeout_seconds = timeout_seconds

    def _url(self, path: str, params: dict[str, Any] | None = None) -> str:
        query = urllib.parse.urlencode(
            {key: value for key, value in (params or {}).items() if value is not None}
        )
        normalized_path = path if path.startswith("/") else f"/{path}"
        return f"{self.base_url}{normalized_path}{'?' + query if query else ''}"

    def get(self, path: str, params: dict[str, Any] | None = None, use_cache: bool = True) -> dict[str, Any]:
        """Fetch a Stats API JSON payload."""
        url = self._url(path, params)

        def fetch() -> dict[str, Any]:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": "mlb-stats-bot/knowledge-layer"},
            )
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))

        if not use_cache:
            return fetch()
        return self.cache.get_or_set_json("mlb_statsapi", url, fetch)

    def schedule(self, date: str, hydrate: str = "probablePitcher,team,venue,weather,linescore") -> dict[str, Any]:
        """Return MLB schedule for one date."""
        return self.get(
            "/schedule",
            {
                "sportId": 1,
                "date": date,
                "gameTypes": "R",
                "hydrate": hydrate,
            },
        )

    def teams(self, season: int | None = None) -> dict[str, Any]:
        """Return MLB teams."""
        return self.get("/teams", {"sportId": 1, "season": season})

    def standings(self, season: int, date: str | None = None) -> dict[str, Any]:
        """Return standings for a season and optional date."""
        return self.get(
            "/standings",
            {
                "leagueId": "103,104",
                "season": season,
                "standingsTypes": "regularSeason",
                "hydrate": "record",
                "date": date,
            },
        )

    def roster(self, team_id: int, season: int | None = None, roster_type: str = "active") -> dict[str, Any]:
        """Return a team roster."""
        return self.get(f"/teams/{team_id}/roster", {"season": season, "rosterType": roster_type})

    def player(self, player_id: int, hydrate: str | None = None) -> dict[str, Any]:
        """Return player metadata."""
        return self.get(f"/people/{player_id}", {"hydrate": hydrate})

    def boxscore(self, game_pk: int) -> dict[str, Any]:
        """Return game boxscore."""
        return self.get(f"/game/{game_pk}/boxscore")

    def live_feed(self, game_pk: int) -> dict[str, Any]:
        """Return live feed for a game."""
        return self.get(f"/game/{game_pk}/feed/live", use_cache=False)

    def game_context(self, game_pk: int) -> dict[str, Any]:
        """Return a compact context from live feed and boxscore."""
        feed = self.live_feed(game_pk)
        game_data = feed.get("gameData", {})
        live_data = feed.get("liveData", {})
        return {
            "game_pk": game_pk,
            "status": game_data.get("status", {}),
            "teams": game_data.get("teams", {}),
            "venue": game_data.get("venue", {}),
            "weather": game_data.get("weather", {}),
            "probable_pitchers": game_data.get("probablePitchers", {}),
            "linescore": live_data.get("linescore", {}),
            "boxscore": live_data.get("boxscore", {}),
        }

