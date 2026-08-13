"""Offline extractor for timestamp-safe candidate feature families (P4).

Reads the generic ``feature_snapshots`` store (written by JS pre-game collectors
in ``src/core/candidate_features.js``) and builds a versioned numeric candidate
feature vector per ``game_pk`` for shadow research/training only. This module
NEVER runs inside ``/predict`` (no Python child process in the live path) and
NEVER mutates production tables.

Candidate schema version: ``mlb-candidate-features-v1.0`` — separate from the
control ``mlb-control-features-v1.0`` / ``mlb-feature-vector-v1.0`` vector.
Adding a candidate family bumps this version.

Timestamp-safe contracts enforced here:
  - Every candidate feature is sourced from a payload that carries its own
    ``as_of_utc`` / ``fetched_at_utc`` provenance. A candidate value is only
    emitted when ``as_of_utc < first_pitch_utc`` (promotion-safe).
  - A payload whose source timestamp is missing or post-pitch is dropped for
    that family (the feature becomes null, never fabricated).
  - Missing local data stays null with a ``missing_<feature>`` indicator and a
    recorded sample size. League-average shrinkage happens at training time
    (inside the training fold), not here — the extractor only carries observed
    values, sample sizes, and provenance.
  - Outcomes are separate labels and are NEVER embedded in candidate vectors.

The extractor is deliberately conservative: it returns null for any family
whose payload is absent, malformed, or temporally ineligible. Downstream
shadow training treats nulls via fold-internal imputation (same rule as P2/P3).
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

CANDIDATE_FEATURE_SCHEMA_VERSION = "mlb-candidate-features-v1.0"
CANDIDATE_FEATURE_MANIFEST_VERSION = "candidate-features-v1"

# Ordered list of candidate numeric features produced by this extractor.
# Each is paired (home/away) where applicable. A missing payload yields null +
# a missing_<feature>=1 indicator. Sample sizes live under <feature>_sample.
CANDIDATE_FEATURE_NAMES: list[str] = [
    # Statcast team rolling xStats (batter-side, prior-date)
    "awayTeamXwoba", "homeTeamXwoba",
    "awayTeamXslg", "homeTeamXslg",
    "awayTeamBarrelRate", "homeTeamBarrelRate",
    "awayTeamHardHitRate", "homeTeamHardHitRate",
    "awayTeamXwobaSample", "homeTeamXwobaSample",
    # Pitch arsenal (starter Stuff+ + platoon split)
    "awayStarterStuffPlus", "homeStarterStuffPlus",
    "awayStarterStuffVsLhh", "homeStarterStuffVsRhh",
    "awayStarterStuffSample", "homeStarterStuffSample",
    # Expected starter innings (projection)
    "awayStarterExpectedInnings", "homeStarterExpectedInnings",
    "awayStarterInningsSample", "homeStarterInningsSample",
    # Available bullpen quality (prior-date reliever quality weighted by
    # expected bullpen innings = 9 - expected starter innings)
    "awayBullpenQuality", "homeBullpenQuality",
    "awayBullpenAvailInnings", "homeBullpenAvailInnings",
    "awayBullpenQualitySample", "homeBullpenQualitySample",
    # Batter-level lineup weight vs opposing starter hand (AB-weighted OPS)
    "awayLineupWeightedOps", "homeLineupWeightedOps",
    "awayLineupBattersCaptured", "homeLineupBattersCaptured",
    "awayLineupConfirmed", "homeLineupConfirmed",
    # BvP (lineup-vs-starter, PA-shrunk; null below MIN_PLATE_APPEARANCES)
    "awayLineupBvpOps", "homeLineupBvpOps",
    "awayLineupBvpPa", "homeLineupBvpPa",
    # Pitcher recent contact-quality (xERA proxy from Statcast)
    "awayStarterXera", "homeStarterXera",
    "awayStarterXeraSample", "homeStarterXeraSample",
]


@dataclass
class CandidateRow:
    """One game's candidate feature vector + provenance."""

    game_pk: str
    date_ymd: str
    as_of_utc: str | None
    first_pitch_utc: str | None
    schema_version: str
    feature_vector: dict[str, Any]
    feature_vector_hash: str
    families_available: list[str] = field(default_factory=list)
    families_missing: list[str] = field(default_factory=list)
    temporal_rejections: list[str] = field(default_factory=list)


def _parse_ts(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def _safe_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    import math
    return f if math.isfinite(f) else None


def _stable_stringify(value: Any) -> str:
    """Deterministic stringify mirroring JS stableStringify (see feature_vector.js)."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int,)):
        return str(value)
    if isinstance(value, float):
        # Mirror JS: integer floats -> str(int), else json.dumps
        if value.is_integer():
            return str(int(value))
        return json.dumps(value)
    if value is None:
        return json.dumps(None)
    if isinstance(value, list):
        return "[" + ",".join(_stable_stringify(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        return "{" + ",".join(f"{json.dumps(k)}:{_stable_stringify(value[k])}" for k in keys) + "}"
    return json.dumps(value)


def _hash_candidate_vector(vector: dict[str, Any]) -> str:
    body = {k: v for k, v in vector.items() if k != "featureVectorHash"}
    return hashlib.sha256(_stable_stringify(body).encode()).hexdigest()


def _is_promotion_safe(payload: dict[str, Any], first_pitch_ts: float | None) -> tuple[bool, str | None]:
    """A candidate payload is promotion-safe only when its source evidence was
    observed strictly before first pitch. Returns (safe, reason).
    """
    if first_pitch_ts is None:
        # No first pitch known at extract time — cannot prove safety.
        return False, "missing_first_pitch"
    as_of = _parse_ts(payload.get("as_of_utc"))
    fetched = _parse_ts(payload.get("fetched_at_utc"))
    # Require at least one valid pre-pitch timestamp.
    evidence_ts = as_of or fetched
    if evidence_ts is None:
        return False, "missing_source_timestamp"
    if evidence_ts >= first_pitch_ts:
        return False, "post_pitch_source"
    return True, None


def _load_snapshots_by_game(db_path: str) -> dict[str, dict[str, dict[str, Any]]]:
    """Load feature_snapshots grouped [game_pk][feature_group] -> payload row."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT game_pk, feature_group, date_ymd, payload, timestamp "
            "FROM feature_snapshots"
        ).fetchall()
    finally:
        conn.close()

    by_game: dict[str, dict[str, dict[str, Any]]] = {}
    for r in rows:
        game = str(r["game_pk"])
        group = r["feature_group"]
        payload: Any
        try:
            payload = json.loads(r["payload"]) if r["payload"] else None
        except (ValueError, TypeError):
            payload = None
        by_game.setdefault(game, {})[group] = {
            "date_ymd": r["date_ymd"],
            "timestamp": r["timestamp"],
            "payload": payload if isinstance(payload, dict) else {},
        }
    return by_game


def _extract_statcast_team(snapshots: dict[str, dict[str, Any]], team_side: str) -> dict[str, Any]:
    """Pull team rolling xStats from the statcast_team payload for one side."""
    fam = snapshots.get("statcast_team", {})
    payload = fam.get("payload", {}) or {}
    side_payload = payload.get(team_side, {}) or {}
    return {
        "xwoba": _safe_float(side_payload.get("xwoba")),
        "xslg": _safe_float(side_payload.get("xslg")),
        "barrel_rate": _safe_float(side_payload.get("barrel_rate")),
        "hard_hit_rate": _safe_float(side_payload.get("hard_hit_rate")),
        "sample": _safe_float(side_payload.get("sample_pa")),
    }


def _extract_pitch_arsenal(snapshots: dict[str, dict[str, Any]], starter_side: str) -> dict[str, Any]:
    """Stuff+ + platoon split from the pitch_arsenal payload for one starter."""
    fam = snapshots.get("pitch_arsenal", {})
    payload = fam.get("payload", {}) or {}
    side_payload = payload.get(starter_side, {}) or {}
    return {
        "stuff_plus": _safe_float(side_payload.get("overall_stuff_plus")),
        "stuff_vs_lhh": _safe_float(side_payload.get("stuff_vs_lhh")),
        "stuff_vs_rhh": _safe_float(side_payload.get("stuff_vs_rhh")),
        "sample": _safe_float(side_payload.get("sample_pitches")),
    }


def _extract_expected_innings(snapshots: dict[str, dict[str, Any]], starter_side: str) -> dict[str, Any]:
    fam = snapshots.get("expected_innings", {})
    payload = fam.get("payload", {}) or {}
    side_payload = payload.get(starter_side, {}) or {}
    return {
        "expected_innings": _safe_float(side_payload.get("expected_innings")),
        "sample": _safe_float(side_payload.get("prior_starts")),
    }


def _extract_bullpen_quality(snapshots: dict[str, dict[str, Any]], team_side: str) -> dict[str, Any]:
    fam = snapshots.get("bullpen_quality", {})
    payload = fam.get("payload", {}) or {}
    side_payload = payload.get(team_side, {}) or {}
    return {
        "quality": _safe_float(side_payload.get("quality_score")),
        "avail_innings": _safe_float(side_payload.get("available_innings")),
        "sample": _safe_float(side_payload.get("sample_relievers")),
    }


def _extract_lineup(snapshots: dict[str, dict[str, Any]], team_side: str) -> dict[str, Any]:
    """Batter-level lineup weight + confirmation state."""
    fam = snapshots.get("lineup_batter", {})
    payload = fam.get("payload", {}) or {}
    side_payload = payload.get(team_side, {}) or {}
    return {
        "weighted_ops": _safe_float(side_payload.get("weighted_ops")),
        "batters_captured": _safe_float(side_payload.get("batters_captured")),
        "confirmed": side_payload.get("confirmed"),
    }


def _extract_bvp(snapshots: dict[str, dict[str, Any]], lineup_side: str) -> dict[str, Any]:
    """Lineup-vs-opposing-starter BvP (PA-shrunk at collection; null below floor)."""
    fam = snapshots.get("bvp", {})
    payload = fam.get("payload", {}) or {}
    side_payload = payload.get(lineup_side, {}) or {}
    return {
        "ops": _safe_float(side_payload.get("ops")),
        "pa": _safe_float(side_payload.get("plate_appearances")),
    }


def _extract_starter_xera(snapshots: dict[str, dict[str, Any]], starter_side: str) -> dict[str, Any]:
    fam = snapshots.get("starter_xera", {})
    payload = fam.get("payload", {}) or {}
    side_payload = payload.get(starter_side, {}) or {}
    return {
        "xera": _safe_float(side_payload.get("xera")),
        "sample": _safe_float(side_payload.get("sample_bf")),
    }


def build_candidate_vector(
    game_pk: str,
    date_ymd: str,
    as_of_utc: str | None,
    first_pitch_utc: str | None,
    snapshots: dict[str, dict[str, Any]],
) -> CandidateRow:
    """Build one game's candidate feature vector from stored snapshot payloads.

    Each family payload is checked for promotion-safety (source evidence strictly
    before first pitch). An unsafe/missing family yields null features for that
    family plus a missingness indicator — never a fabricated value.
    """
    first_pitch_ts = _parse_ts(first_pitch_utc)
    vector: dict[str, Any] = {
        "schemaVersion": CANDIDATE_FEATURE_SCHEMA_VERSION,
        "gamePk": game_pk,
        "dateYmd": date_ymd,
    }
    families_available: list[str] = []
    families_missing: list[str] = []
    temporal_rejections: list[str] = []

    def _safe_family(group: str) -> dict[str, dict[str, Any]] | None:
        """Return the family's snapshots dict if promotion-safe, else None."""
        fam = snapshots.get(group)
        if not fam or not fam.get("payload"):
            families_missing.append(group)
            return None
        payload = fam["payload"]
        # Inject provenance from the wrapper if the payload lacks it.
        if "as_of_utc" not in payload and "fetched_at_utc" not in payload:
            payload = {**payload, "as_of_utc": fam.get("timestamp")}
        safe, reason = _is_promotion_safe(payload, first_pitch_ts)
        if not safe:
            temporal_rejections.append(f"{group}:{reason}")
            families_missing.append(group)
            return None
        families_available.append(group)
        return snapshots

    # --- Statcast team xStats ---
    if _safe_family("statcast_team"):
        away = _extract_statcast_team(snapshots, "away")
        home = _extract_statcast_team(snapshots, "home")
        vector["awayTeamXwoba"] = away["xwoba"]
        vector["homeTeamXwoba"] = home["xwoba"]
        vector["awayTeamXslg"] = away["xslg"]
        vector["homeTeamXslg"] = home["xslg"]
        vector["awayTeamBarrelRate"] = away["barrel_rate"]
        vector["homeTeamBarrelRate"] = home["barrel_rate"]
        vector["awayTeamHardHitRate"] = away["hard_hit_rate"]
        vector["homeTeamHardHitRate"] = home["hard_hit_rate"]
        vector["awayTeamXwobaSample"] = away["sample"]
        vector["homeTeamXwobaSample"] = home["sample"]
    else:
        for n in ["awayTeamXwoba", "homeTeamXwoba", "awayTeamXslg", "homeTeamXslg",
                  "awayTeamBarrelRate", "homeTeamBarrelRate", "awayTeamHardHitRate",
                  "homeTeamHardHitRate", "awayTeamXwobaSample", "homeTeamXwobaSample"]:
            vector[n] = None

    # --- Pitch arsenal ---
    if _safe_family("pitch_arsenal"):
        away = _extract_pitch_arsenal(snapshots, "away")
        home = _extract_pitch_arsenal(snapshots, "home")
        vector["awayStarterStuffPlus"] = away["stuff_plus"]
        vector["homeStarterStuffPlus"] = home["stuff_plus"]
        vector["awayStarterStuffVsLhh"] = away["stuff_vs_lhh"]
        vector["homeStarterStuffVsRhh"] = home["stuff_vs_rhh"]
        vector["awayStarterStuffSample"] = away["sample"]
        vector["homeStarterStuffSample"] = home["sample"]
    else:
        for n in ["awayStarterStuffPlus", "homeStarterStuffPlus", "awayStarterStuffVsLhh",
                  "homeStarterStuffVsRhh", "awayStarterStuffSample", "homeStarterStuffSample"]:
            vector[n] = None

    # --- Expected innings ---
    if _safe_family("expected_innings"):
        away = _extract_expected_innings(snapshots, "away")
        home = _extract_expected_innings(snapshots, "home")
        vector["awayStarterExpectedInnings"] = away["expected_innings"]
        vector["homeStarterExpectedInnings"] = home["expected_innings"]
        vector["awayStarterInningsSample"] = away["sample"]
        vector["homeStarterInningsSample"] = home["sample"]
    else:
        for n in ["awayStarterExpectedInnings", "homeStarterExpectedInnings",
                  "awayStarterInningsSample", "homeStarterInningsSample"]:
            vector[n] = None

    # --- Bullpen quality ---
    if _safe_family("bullpen_quality"):
        away = _extract_bullpen_quality(snapshots, "away")
        home = _extract_bullpen_quality(snapshots, "home")
        vector["awayBullpenQuality"] = away["quality"]
        vector["homeBullpenQuality"] = home["quality"]
        vector["awayBullpenAvailInnings"] = away["avail_innings"]
        vector["homeBullpenAvailInnings"] = home["avail_innings"]
        vector["awayBullpenQualitySample"] = away["sample"]
        vector["homeBullpenQualitySample"] = home["sample"]
    else:
        for n in ["awayBullpenQuality", "homeBullpenQuality", "awayBullpenAvailInnings",
                  "homeBullpenAvailInnings", "awayBullpenQualitySample", "homeBullpenQualitySample"]:
            vector[n] = None

    # --- Lineup batter weights ---
    if _safe_family("lineup_batter"):
        away = _extract_lineup(snapshots, "away")
        home = _extract_lineup(snapshots, "home")
        vector["awayLineupWeightedOps"] = away["weighted_ops"]
        vector["homeLineupWeightedOps"] = home["weighted_ops"]
        vector["awayLineupBattersCaptured"] = away["batters_captured"]
        vector["homeLineupBattersCaptured"] = home["batters_captured"]
        vector["awayLineupConfirmed"] = away["confirmed"]
        vector["homeLineupConfirmed"] = home["confirmed"]
    else:
        for n in ["awayLineupWeightedOps", "homeLineupWeightedOps",
                  "awayLineupBattersCaptured", "homeLineupBattersCaptured",
                  "awayLineupConfirmed", "homeLineupConfirmed"]:
            vector[n] = None

    # --- BvP ---
    if _safe_family("bvp"):
        away = _extract_bvp(snapshots, "away")
        home = _extract_bvp(snapshots, "home")
        vector["awayLineupBvpOps"] = away["ops"]
        vector["homeLineupBvpOps"] = home["ops"]
        vector["awayLineupBvpPa"] = away["pa"]
        vector["homeLineupBvpPa"] = home["pa"]
    else:
        for n in ["awayLineupBvpOps", "homeLineupBvpOps", "awayLineupBvpPa", "homeLineupBvpPa"]:
            vector[n] = None

    # --- Starter xERA ---
    if _safe_family("starter_xera"):
        away = _extract_starter_xera(snapshots, "away")
        home = _extract_starter_xera(snapshots, "home")
        vector["awayStarterXera"] = away["xera"]
        vector["homeStarterXera"] = home["xera"]
        vector["awayStarterXeraSample"] = away["sample"]
        vector["homeStarterXeraSample"] = home["sample"]
    else:
        for n in ["awayStarterXera", "homeStarterXera", "awayStarterXeraSample", "homeStarterXeraSample"]:
            vector[n] = None

    # Missingness indicators for every numeric candidate feature.
    for name in CANDIDATE_FEATURE_NAMES:
        if name not in vector:
            vector[name] = None
        vector[f"missing_{name}"] = 1 if vector.get(name) is None else 0

    feature_hash = _hash_candidate_vector(vector)
    vector["featureVectorHash"] = feature_hash

    return CandidateRow(
        game_pk=game_pk,
        date_ymd=date_ymd,
        as_of_utc=as_of_utc,
        first_pitch_utc=first_pitch_utc,
        schema_version=CANDIDATE_FEATURE_SCHEMA_VERSION,
        feature_vector=vector,
        feature_vector_hash=feature_hash,
        families_available=families_available,
        families_missing=families_missing,
        temporal_rejections=temporal_rejections,
    )


def build_candidate_dataset(
    db_path: str,
    game_rows: list[dict[str, Any]] | None = None,
) -> dict[str, CandidateRow]:
    """Build candidate vectors for all games that have stored snapshots.

    ``game_rows`` optional: list of {game_pk, date_ymd, as_of_utc, first_pitch_utc}
    to restrict/annotate extraction (e.g. from the main cohort). If omitted, all
    games with any snapshot are extracted using snapshot date + payload provenance.

    Returns {game_pk: CandidateRow}. Never mutates production tables.
    """
    snapshots_by_game = _load_snapshots_by_game(db_path)
    out: dict[str, CandidateRow] = {}

    if game_rows is None:
        # Derive a minimal game list from snapshot dates.
        game_rows = []
        for game_pk, groups in snapshots_by_game.items():
            date_ymd = ""
            for grp in groups.values():
                date_ymd = grp.get("date_ymd") or ""
                if date_ymd:
                    break
            game_rows.append({"game_pk": game_pk, "date_ymd": date_ymd})

    for row in game_rows:
        game_pk = str(row.get("game_pk"))
        if not game_pk:
            continue
        snaps = snapshots_by_game.get(game_pk, {})
        if not snaps:
            continue
        out[game_pk] = build_candidate_vector(
            game_pk=game_pk,
            date_ymd=row.get("date_ymd") or "",
            as_of_utc=row.get("as_of_utc"),
            first_pitch_utc=row.get("first_pitch_utc"),
            snapshots=snaps,
        )
    return out


def candidate_coverage_summary(rows: dict[str, CandidateRow]) -> dict[str, Any]:
    """Summarize candidate family coverage/fallback/sample across extracted rows.

    Used by the feature-quality report. No outcomes — pure availability stats.
    """
    n = len(rows)
    if n == 0:
        return {"row_count": 0, "families": {}, "temporal_rejections": {}}
    family_avail: dict[str, int] = {}
    family_missing: dict[str, int] = {}
    temporal: dict[str, int] = {}
    for r in rows.values():
        for f in r.families_available:
            family_avail[f] = family_avail.get(f, 0) + 1
        for f in r.families_missing:
            family_missing[f] = family_missing.get(f, 0) + 1
        for t in r.temporal_rejections:
            temporal[t] = temporal.get(t, 0) + 1
    families = {}
    all_groups = sorted(set(family_avail) | set(family_missing))
    for g in all_groups:
        avail = family_avail.get(g, 0)
        families[g] = {
            "available": avail,
            "missing": family_missing.get(g, 0),
            "coverage_pct": round(100.0 * avail / n, 1) if n else 0.0,
        }
    return {
        "row_count": n,
        "families": families,
        "temporal_rejections": temporal,
    }
