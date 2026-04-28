"""Optional pybaseball adapter for Statcast, FanGraphs, and Baseball Reference data."""

from __future__ import annotations

from typing import Any

from .cache import LocalCache


class PyBaseballClient:
    """Thin cached wrapper around pybaseball.

    pybaseball is optional. The rest of the project can run from local CSVs
    without it; methods raise a clear error only when live pybaseball data is
    requested and the package is not installed.
    """

    def __init__(self, cache: LocalCache | None = None) -> None:
        self.cache = cache or LocalCache(ttl_seconds=24 * 60 * 60)

    @staticmethod
    def _module() -> Any:
        try:
            import pybaseball  # type: ignore
        except ImportError as exc:  # pragma: no cover - depends on optional package
            raise RuntimeError(
                "pybaseball is optional. Install it with `pip install pybaseball` "
                "to enable live Statcast/FanGraphs/Baseball Reference pulls."
            ) from exc
        return pybaseball

    def _records(self, function_name: str, *args: Any, **kwargs: Any) -> list[dict[str, Any]]:
        key = f"{function_name}:{args}:{sorted(kwargs.items())}"

        def fetch() -> list[dict[str, Any]]:
            module = self._module()
            function = getattr(module, function_name)
            frame = function(*args, **kwargs)
            if hasattr(frame, "to_dict"):
                return frame.to_dict(orient="records")
            return list(frame)

        return self.cache.get_or_set_json("pybaseball", key, fetch)

    def statcast(self, start_dt: str, end_dt: str, player_id: int | None = None) -> list[dict[str, Any]]:
        """Return Statcast pitch-level data from Baseball Savant via pybaseball."""
        if player_id is None:
            return self._records("statcast", start_dt, end_dt)
        return self._records("statcast_pitcher", start_dt, end_dt, player_id)

    def batting_stats(self, start_season: int, end_season: int | None = None, qual: int = 0) -> list[dict[str, Any]]:
        """Return FanGraphs batting leaderboard rows."""
        return self._records("batting_stats", start_season, end_season or start_season, qual=qual)

    def pitching_stats(self, start_season: int, end_season: int | None = None, qual: int = 0) -> list[dict[str, Any]]:
        """Return FanGraphs pitching leaderboard rows."""
        return self._records("pitching_stats", start_season, end_season or start_season, qual=qual)

    def team_batting(self, start_season: int, end_season: int | None = None) -> list[dict[str, Any]]:
        """Return team batting stats when supported by the installed pybaseball version."""
        return self._records("team_batting", start_season, end_season or start_season)

    def team_pitching(self, start_season: int, end_season: int | None = None) -> list[dict[str, Any]]:
        """Return team pitching stats when supported by the installed pybaseball version."""
        return self._records("team_pitching", start_season, end_season or start_season)

