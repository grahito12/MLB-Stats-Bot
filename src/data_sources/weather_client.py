"""Optional weather API clients for MLB run-environment context."""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Any

from ..env import load_dotenv
from ..weather import WeatherContext
from .cache import LocalCache

OPENWEATHER_BASE_URL = "https://api.openweathermap.org/data/2.5"
NWS_BASE_URL = "https://api.weather.gov"


class WeatherApiClient:
    """Weather adapter using OpenWeather when keyed, otherwise NOAA/NWS when possible."""

    def __init__(
        self,
        openweather_api_key: str | None = None,
        cache: LocalCache | None = None,
        timeout_seconds: int = 20,
    ) -> None:
        load_dotenv()
        self.openweather_api_key = openweather_api_key or os.getenv("OPENWEATHER_API_KEY") or ""
        self.cache = cache or LocalCache(ttl_seconds=900)
        self.timeout_seconds = timeout_seconds

    def _fetch_json(self, url: str, namespace: str) -> Any:
        def fetch() -> Any:
            request = urllib.request.Request(url, headers={"User-Agent": "mlb-stats-bot/weather"})
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read().decode("utf-8"))

        return self.cache.get_or_set_json(namespace, url, fetch)

    def openweather_current(self, latitude: float, longitude: float) -> dict[str, Any] | None:
        """Return OpenWeather current conditions when OPENWEATHER_API_KEY is set."""
        if not self.openweather_api_key:
            return None
        query = urllib.parse.urlencode(
            {
                "lat": latitude,
                "lon": longitude,
                "appid": self.openweather_api_key,
                "units": "imperial",
            }
        )
        return self._fetch_json(f"{OPENWEATHER_BASE_URL}/weather?{query}", "openweather")

    def nws_forecast(self, latitude: float, longitude: float) -> dict[str, Any]:
        """Return NOAA/NWS forecast grid response and first forecast period."""
        points_url = f"{NWS_BASE_URL}/points/{latitude:.4f},{longitude:.4f}"
        points = self._fetch_json(points_url, "nws")
        forecast_url = points.get("properties", {}).get("forecast")
        if not forecast_url:
            return {}
        forecast = self._fetch_json(forecast_url, "nws")
        periods = forecast.get("properties", {}).get("periods", [])
        return periods[0] if periods else {}

    def context_from_openweather(
        self,
        home_team: str,
        away_team: str,
        latitude: float,
        longitude: float,
    ) -> WeatherContext | None:
        """Convert OpenWeather payload into the project WeatherContext."""
        payload = self.openweather_current(latitude, longitude)
        if not payload:
            return None
        wind_degrees = payload.get("wind", {}).get("deg")
        return WeatherContext(
            home_team=home_team,
            away_team=away_team,
            temperature=float(payload.get("main", {}).get("temp", 70.0)),
            wind_speed=float(payload.get("wind", {}).get("speed", 0.0)),
            wind_direction=f"{wind_degrees} degrees" if wind_degrees is not None else "calm",
            humidity=float(payload.get("main", {}).get("humidity", 50.0)),
            air_pressure=float(payload.get("main", {}).get("pressure", 1013.0)) * 0.02953,
            roof="open",
        )

    @staticmethod
    def game_hour_bucket(game_time: str | datetime | None) -> str:
        """Return a stable bucket used by callers that cache by first-pitch time."""
        if game_time is None:
            return "unknown"
        if isinstance(game_time, datetime):
            return game_time.strftime("%Y-%m-%dT%H")
        return str(game_time)[:13]
