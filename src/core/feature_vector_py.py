"""Python mirror of src/core/feature_vector.js (buildFeatureVector + flatten).

Canonical source of truth is the JavaScript module. This Python port exists so
offline training/parity tests can construct the SAME flattened feature vector
from frozen coreInputs without spawning a Node subprocess for every row. It is
kept in lock-step with the JS contract by the JS/Python parity tests; any
feature added to the JS module must be mirrored here or the parity test fails.

It does NOT run in production inference (JS is canonical there).
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any

FEATURE_VECTOR_SCHEMA_VERSION = "mlb-feature-vector-v1.0"
CONTROL_FEATURE_SCHEMA_VERSION = "mlb-control-features-v1.0"

_META_KEYS = {
    "schemaVersion", "featureSchemaVersion", "gamePk", "awayTeamId",
    "homeTeamId", "venueId", "officialDate", "featureVectorHash",
}


def _num(value: Any, fallback: Any = None) -> Any:
    if value is None:
        return fallback
    if isinstance(value, bool):
        return fallback
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(n):
        return fallback
    return n


def _gp(stat: dict | None) -> float:
    if not stat:
        return 1.0
    games = stat.get("gamesPlayed", stat.get("hitting", {}).get("gamesPlayed")) if isinstance(stat, dict) else None
    n = _num(games, 1.0)
    return max(1.0, n)


def _rpg(stat: dict | None) -> float | None:
    if not stat:
        return None
    runs = stat.get("runs", stat.get("hitting", {}).get("runs")) if isinstance(stat, dict) else None
    runs = _num(runs, None)
    if runs is None:
        return None
    return runs / _gp(stat)


def _ops(stat: dict | None) -> float | None:
    if not stat:
        return None
    return _num(stat.get("ops", stat.get("hitting", {}).get("ops")), None) if isinstance(stat, dict) else None


def _era(stat: dict | None) -> float | None:
    if not stat:
        return None
    return _num(stat.get("era", stat.get("pitching", {}).get("era")), None) if isinstance(stat, dict) else None


def _whip(stat: dict | None) -> float | None:
    if not stat:
        return None
    return _num(stat.get("whip", stat.get("pitching", {}).get("whip")), None) if isinstance(stat, dict) else None


def _record_pct(record: dict | None) -> float | None:
    if not record:
        return None
    if record.get("pct") is not None:
        return _num(record["pct"], None)
    w = _num(record.get("wins"), 0.0)
    l = _num(record.get("losses"), 0.0)
    t = w + l
    return (w / t) if t > 0 else None


def _split_pct(standing: dict | None, stype: str) -> float | None:
    if not standing:
        return None
    splits = standing.get("records", {}).get("splitRecords") if isinstance(standing, dict) else None
    if not splits:
        return None
    rec = next((r for r in splits if r.get("type") == stype), None)
    return _record_pct(rec) if rec else None


def _run_diff_per_game(standing: dict | None) -> float | None:
    if not standing:
        return None
    rd = _num(standing.get("runDifferential"), None)
    games = _num(standing.get("gamesPlayed"), None)
    if games is None and standing.get("leagueRecord"):
        games = _num(standing["leagueRecord"].get("wins"), 0.0) + _num(standing["leagueRecord"].get("losses"), 0.0)
    if rd is None or not games or games <= 0:
        return None
    return rd / games


def _games_played_record(standing: dict | None) -> float | None:
    if not standing:
        return None
    games = standing.get("gamesPlayed")
    if games is None and standing.get("leagueRecord"):
        games = _num(standing["leagueRecord"].get("wins"), 0.0) + _num(standing["leagueRecord"].get("losses"), 0.0)
    return _num(games, None)


def _with_missing(value: Any) -> dict:
    return {"value": value, "missing": 1 if value is None else 0}


def buildFeatureVector(coreInputs: dict) -> dict:
    raw = coreInputs or {}
    game = raw.get("game") or {}
    teams = game.get("teams") or {}
    away_team = (teams.get("away") or {}).get("team") or {}
    home_team = (teams.get("home") or {}).get("team") or {}
    away_id = away_team.get("id")
    home_id = home_team.get("id")

    def at(obj, idx):
        return obj.get(str(idx)) if (obj and idx is not None) else None

    away_stats = at(raw.get("teamStats"), away_id)
    home_stats = at(raw.get("teamStats"), home_id)
    away_standing = at(raw.get("standings"), away_id)
    home_standing = at(raw.get("standings"), home_id)
    away_rolling = at(raw.get("rollingTeamStats"), away_id)
    home_rolling = at(raw.get("rollingTeamStats"), home_id)

    away_pitcher_id = (teams.get("away") or {}).get("probablePitcher", {}).get("id")
    home_pitcher_id = (teams.get("home") or {}).get("probablePitcher", {}).get("id")
    away_pitcher = at(raw.get("pitcherStats"), away_pitcher_id)
    home_pitcher = at(raw.get("pitcherStats"), home_pitcher_id)
    away_pitcher_recent = at(raw.get("pitcherRecentStarts"), away_pitcher_id)
    home_pitcher_recent = at(raw.get("pitcherRecentStarts"), home_pitcher_id)

    away_bullpen = at(raw.get("bullpenProfiles"), away_id)
    home_bullpen = at(raw.get("bullpenProfiles"), home_id)
    away_sched = at(raw.get("scheduleFatigueProfiles"), away_id)
    home_sched = at(raw.get("scheduleFatigueProfiles"), home_id)
    away_injuries = at(raw.get("injuryProfiles"), away_id)
    home_injuries = at(raw.get("injuryProfiles"), home_id)

    lineup = raw.get("lineupProfiles") or {}
    away_lineup = lineup.get("away")
    home_lineup = lineup.get("home")
    h2h = raw.get("headToHead")

    weather = game.get("weather") or {}
    temp_num = _num(weather.get("temp"), None)
    wind = weather.get("wind")
    wind_match = re.match(r"([\d.]+)\s*mph", wind, re.I) if isinstance(wind, str) else None
    wind_speed = _num(wind_match.group(1), None) if wind_match else None
    wind_out = bool(re.search(r"out|cf|lf|rf", wind, re.I)) if isinstance(wind, str) else None
    wind_in = bool(re.search(r"\bin\b", wind, re.I)) if isinstance(wind, str) else None

    away_starter_hand = (teams.get("away") or {}).get("probablePitcher", {}).get("pitchHand", {}).get("code")
    home_starter_hand = (teams.get("home") or {}).get("probablePitcher", {}).get("pitchHand", {}).get("code")

    vector: dict[str, Any] = {
        "schemaVersion": FEATURE_VECTOR_SCHEMA_VERSION,
        "featureSchemaVersion": CONTROL_FEATURE_SCHEMA_VERSION,
        "gamePk": str(game.get("gamePk", "")),
        "awayTeamId": str(away_id) if away_id is not None else None,
        "homeTeamId": str(home_id) if home_id is not None else None,
        "venueId": _num(game.get("venue", {}).get("id"), None) if game.get("venue") else None,
        "officialDate": game.get("officialDate"),

        "awayRpg": _with_missing(_rpg(away_stats)),
        "awayOps": _with_missing(_ops(away_stats)),
        "homeRpg": _with_missing(_rpg(home_stats)),
        "homeOps": _with_missing(_ops(home_stats)),
        "awayTeamGames": _with_missing(_games_played_record(away_standing)),
        "homeTeamGames": _with_missing(_games_played_record(home_standing)),

        "awayEra": _with_missing(_era(away_stats)),
        "awayWhip": _with_missing(_whip(away_stats)),
        "homeEra": _with_missing(_era(home_stats)),
        "homeWhip": _with_missing(_whip(home_stats)),

        "awayRollingRpg": _with_missing(_rpg(away_rolling)),
        "awayRollingOps": _with_missing(_ops(away_rolling)),
        "homeRollingRpg": _with_missing(_rpg(home_rolling)),
        "homeRollingOps": _with_missing(_ops(home_rolling)),
        "awayRollingGames": _with_missing(_num(away_rolling.get("games"), None) if away_rolling else None),
        "homeRollingGames": _with_missing(_num(home_rolling.get("games"), None) if home_rolling else None),

        "awayWinPct": _with_missing(_record_pct(away_standing.get("leagueRecord") if away_standing else None)),
        "homeWinPct": _with_missing(_record_pct(home_standing.get("leagueRecord") if home_standing else None)),
        "awayLastTenPct": _with_missing(_split_pct(away_standing, "lastTen")),
        "homeLastTenPct": _with_missing(_split_pct(home_standing, "lastTen")),
        "awayRunDiffPerGame": _with_missing(_run_diff_per_game(away_standing)),
        "homeRunDiffPerGame": _with_missing(_run_diff_per_game(home_standing)),
        "awayVsStarterHandPct": _with_missing(
            _split_pct(away_standing, "left") if home_starter_hand == "L" else _split_pct(away_standing, "right")
        ),
        "homeVsStarterHandPct": _with_missing(
            _split_pct(home_standing, "left") if away_starter_hand == "L" else _split_pct(home_standing, "right")
        ),

        "awayStarterEra": _with_missing(_era(away_pitcher)),
        "awayStarterWhip": _with_missing(_whip(away_pitcher)),
        "homeStarterEra": _with_missing(_era(home_pitcher)),
        "homeStarterWhip": _with_missing(_whip(home_pitcher)),
        "awayStarterKMinusBb": _with_missing(_num(away_pitcher.get("strikeoutsMinusWalksPercentage"), None) if away_pitcher else None),
        "homeStarterKMinusBb": _with_missing(_num(home_pitcher.get("strikeoutsMinusWalksPercentage"), None) if home_pitcher else None),
        "awayStarterHr9": _with_missing(_num(away_pitcher.get("homeRunsPer9"), None) if away_pitcher else None),
        "homeStarterHr9": _with_missing(_num(home_pitcher.get("homeRunsPer9"), None) if home_pitcher else None),

        "awayStarterRecentEra": _with_missing(_era(away_pitcher_recent)),
        "awayStarterRecentWhip": _with_missing(_whip(away_pitcher_recent)),
        "awayStarterRecentInnings": _with_missing(_num(away_pitcher_recent.get("innings"), None) if away_pitcher_recent else None),
        "homeStarterRecentEra": _with_missing(_era(home_pitcher_recent)),
        "homeStarterRecentWhip": _with_missing(_whip(home_pitcher_recent)),
        "homeStarterRecentInnings": _with_missing(_num(home_pitcher_recent.get("innings"), None) if home_pitcher_recent else None),

        "awayBullpenFatigue": _with_missing(_num(away_bullpen.get("fatigueScore"), None) if away_bullpen else None),
        "homeBullpenFatigue": _with_missing(_num(home_bullpen.get("fatigueScore"), None) if home_bullpen else None),
        "awayBullpenBackToBack": _with_missing(_num(away_bullpen.get("backToBackRelievers"), None) if away_bullpen else None),
        "homeBullpenBackToBack": _with_missing(_num(home_bullpen.get("backToBackRelievers"), None) if home_bullpen else None),

        "awayRestDays": _with_missing(_num(away_sched.get("restDays"), None) if away_sched else None),
        "homeRestDays": _with_missing(_num(home_sched.get("restDays"), None) if home_sched else None),
        "awayRoadStreak": _with_missing(_num(away_sched.get("roadStreak"), None) if away_sched else None),
        "homeRoadStreak": _with_missing(_num(home_sched.get("roadStreak"), None) if home_sched else None),

        "awayLineupConfirmed": _with_missing(
            None if (away_lineup is None or away_lineup.get("confirmed") is None)
            else (1 if away_lineup.get("confirmed") else 0)
        ),
        "homeLineupConfirmed": _with_missing(
            None if (home_lineup is None or home_lineup.get("confirmed") is None)
            else (1 if home_lineup.get("confirmed") else 0)
        ),
        "awayLineupQuality": _with_missing(_num(away_lineup.get("qualityScore"), None) if away_lineup else None),
        "homeLineupQuality": _with_missing(_num(home_lineup.get("qualityScore"), None) if home_lineup else None),
        "awayLineupCount": _with_missing(_num(away_lineup.get("count"), None) if away_lineup else None),
        "homeLineupCount": _with_missing(_num(home_lineup.get("count"), None) if home_lineup else None),

        "awayInjuryCount": _with_missing(len(away_injuries) if isinstance(away_injuries, list) else None),
        "homeInjuryCount": _with_missing(len(home_injuries) if isinstance(home_injuries, list) else None),

        "h2hGames": _with_missing(_num(h2h.get("games"), None) if h2h else None),
        "h2hHomeWinPct": _with_missing(
            (_num(h2h.get("homeProbability"), None) / 100.0)
            if (h2h and h2h.get("games", 0) and h2h.get("homeProbability") is not None)
            else None
        ),

        "temperature": _with_missing(temp_num),
        "windSpeed": _with_missing(wind_speed),
        "windHittingOut": _with_missing(None if wind_out is None else (1 if wind_out else 0)),
        "windHittingIn": _with_missing(None if wind_in is None else (1 if wind_in else 0)),

        "awayStarterHandLeft": _with_missing(
            None if away_starter_hand is None else (1 if away_starter_hand == "L" else 0)
        ),
        "homeStarterHandLeft": _with_missing(
            None if home_starter_hand is None else (1 if home_starter_hand == "L" else 0)
        ),
    }

    vector["featureVectorHash"] = hashFeatureVector(vector)
    return vector


def _stable_stringify(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        # Match JS: integers as bare, floats via JSON.
        if isinstance(value, float) and value.is_integer():
            return str(int(value))
        if isinstance(value, int):
            return str(value)
        return json.dumps(value)
    if value is None or not isinstance(value, (dict, list)):
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ",".join(_stable_stringify(v) for v in value) + "]"
    keys = sorted(value.keys())
    return "{" + ",".join(f"{json.dumps(k)}:{_stable_stringify(value[k])}" for k in keys) + "}"


def hashFeatureVector(vector: dict) -> str:
    body = {k: v for k, v in vector.items() if k != "featureVectorHash"}
    return hashlib.sha256(_stable_stringify(body).encode()).hexdigest()


def flattenFeatureVector(vector: dict) -> dict:
    flat = {
        "schemaVersion": vector.get("schemaVersion"),
        "featureSchemaVersion": vector.get("featureSchemaVersion"),
        "gamePk": vector.get("gamePk"),
        "awayTeamId": vector.get("awayTeamId"),
        "homeTeamId": vector.get("homeTeamId"),
        "venueId": vector.get("venueId"),
        "officialDate": vector.get("officialDate"),
        "featureVectorHash": vector.get("featureVectorHash"),
    }
    for key, cell in vector.items():
        if key in _META_KEYS:
            continue
        if isinstance(cell, dict) and "value" in cell:
            flat[key] = cell["value"]
            flat[f"missing_{key}"] = cell["missing"]
        else:
            flat[key] = cell
    return flat
