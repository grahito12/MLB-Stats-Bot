"""P4 candidate-feature extractor tests.

Verifies the offline Python extractor:
  - builds a versioned mlb-candidate-features-v1.0 vector from stored snapshots
  - enforces promotion-safety (post-pitch evidence -> null, temporal_rejection)
  - emits null + missing_<feature> for absent/insufficient families
  - never embeds outcomes
  - coverage summary is accurate
"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

from src.candidate_features import (
    build_candidate_dataset,
    build_candidate_vector,
    candidate_coverage_summary,
    CANDIDATE_FEATURE_SCHEMA_VERSION,
    CANDIDATE_FEATURE_NAMES,
)


def _make_db() -> str:
    fd, db_path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE TABLE feature_snapshots ("
        "game_pk TEXT NOT NULL, feature_group TEXT NOT NULL, date_ymd TEXT NOT NULL, "
        "payload TEXT NOT NULL, timestamp TEXT NOT NULL, "
        "PRIMARY KEY (game_pk, feature_group))"
    )
    conn.commit()
    conn.close()
    return db_path


def _write_snapshot(conn, game_pk, group, date_ymd, payload, timestamp=None):
    conn.execute(
        "INSERT OR REPLACE INTO feature_snapshots (game_pk, feature_group, date_ymd, payload, timestamp) "
        "VALUES (?, ?, ?, ?, ?)",
        (game_pk, group, date_ymd, json.dumps(payload), timestamp or "2026-07-21T17:00:00Z"),
    )
    conn.commit()


def _statcast_payload(as_of="2026-07-21T17:00:00Z"):
    return {
        "as_of_utc": as_of,
        "fetched_at_utc": as_of,
        "away": {"xwoba": 0.31, "xslg": 0.39, "barrel_rate": 0.07, "hard_hit_rate": 0.38, "sample_pa": 120},
        "home": {"xwoba": 0.33, "xslg": 0.42, "barrel_rate": 0.09, "hard_hit_rate": 0.41, "sample_pa": 118},
    }


def _arsenal_payload(as_of="2026-07-21T17:00:00Z"):
    return {
        "as_of_utc": as_of,
        "away": {"overall_stuff_plus": 105, "stuff_vs_lhh": 103, "stuff_vs_rhh": 107, "sample_pitches": 60},
        "home": {"overall_stuff_plus": 98, "stuff_vs_lhh": 96, "stuff_vs_rhh": 100, "sample_pitches": 55},
    }


def _bvp_payload(as_of="2026-07-21T17:00:00Z"):
    return {
        "as_of_utc": as_of,
        "away": {"ops": 0.75, "plate_appearances": 60},
        "home": {"ops": 0.68, "plate_appearances": 55},
    }


# ---------- Schema + hash ----------

def test_candidate_schema_version_is_separate_from_control():
    assert CANDIDATE_FEATURE_SCHEMA_VERSION == "mlb-candidate-features-v1.0"
    assert "candidate" in CANDIDATE_FEATURE_SCHEMA_VERSION


def test_candidate_feature_names_covers_all_seven_families():
    names = set(CANDIDATE_FEATURE_NAMES)
    # spot-check one feature per family
    assert "homeTeamXwoba" in names  # statcast
    assert "awayStarterStuffPlus" in names  # arsenal
    assert "homeStarterExpectedInnings" in names  # expected innings
    assert "awayBullpenQuality" in names  # bullpen
    assert "homeLineupWeightedOps" in names  # lineup
    assert "awayLineupBvpOps" in names  # bvp
    assert "homeStarterXera" in names  # xera


# ---------- Extraction from stored snapshots ----------

def test_extract_builds_vector_from_promotion_safe_snapshots():
    db_path = _make_db()
    try:
        conn = sqlite3.connect(db_path)
        _write_snapshot(conn, "7001", "statcast_team", "2026-07-21", _statcast_payload())
        _write_snapshot(conn, "7001", "pitch_arsenal", "2026-07-21", _arsenal_payload())
        _write_snapshot(conn, "7001", "bvp", "2026-07-21", _bvp_payload())
        conn.close()

        rows = build_candidate_dataset(
            db_path,
            game_rows=[{"game_pk": "7001", "date_ymd": "2026-07-21",
                        "as_of_utc": "2026-07-21T17:00:00Z",
                        "first_pitch_utc": "2026-07-21T23:05:00Z"}],
        )
        assert "7001" in rows
        row = rows["7001"]
        assert row.schema_version == CANDIDATE_FEATURE_SCHEMA_VERSION
        v = row.feature_vector
        assert v["awayTeamXwoba"] == 0.31
        assert v["homeTeamXwoba"] == 0.33
        assert v["awayStarterStuffPlus"] == 105
        assert v["homeStarterStuffPlus"] == 98
        assert v["awayLineupBvpOps"] == 0.75
        # families without snapshots -> null + missing flag
        assert v["awayStarterExpectedInnings"] is None
        assert v["missing_awayStarterExpectedInnings"] == 1
        assert v["missing_awayTeamXwoba"] == 0
        # hash is deterministic
        assert row.feature_vector_hash == v["featureVectorHash"]
        assert len(row.feature_vector_hash) == 64
        # provenance
        assert set(["statcast_team", "pitch_arsenal", "bvp"]).issubset(set(row.families_available))
        assert "expected_innings" in row.families_missing
    finally:
        os.unlink(db_path)


def test_extract_never_embeds_outcomes():
    """Candidate vector must carry no outcome/winner/label field."""
    db_path = _make_db()
    try:
        conn = sqlite3.connect(db_path)
        _write_snapshot(conn, "7002", "statcast_team", "2026-07-21", _statcast_payload())
        conn.close()
        rows = build_candidate_dataset(
            db_path,
            game_rows=[{"game_pk": "7002", "date_ymd": "2026-07-21",
                        "as_of_utc": "2026-07-21T17:00:00Z",
                        "first_pitch_utc": "2026-07-21T23:05:00Z"}],
        )
        v = rows["7002"].feature_vector
        for key in v:
            kl = key.lower()
            assert "won" not in kl
            assert "winner" not in kl
            assert "outcome" not in kl
            assert "score" not in kl
            assert "result" not in kl
    finally:
        os.unlink(db_path)


# ---------- Temporal safety ----------

def test_extract_rejects_post_pitch_evidence():
    """A payload whose as_of is post-pitch must be rejected for that family."""
    db_path = _make_db()
    try:
        conn = sqlite3.connect(db_path)
        # post-pitch as_of
        _write_snapshot(conn, "7003", "statcast_team", "2026-07-21",
                        _statcast_payload(as_of="2026-07-22T00:30:00Z"))
        conn.close()
        rows = build_candidate_dataset(
            db_path,
            game_rows=[{"game_pk": "7003", "date_ymd": "2026-07-21",
                        "as_of_utc": "2026-07-22T00:30:00Z",
                        "first_pitch_utc": "2026-07-21T23:05:00Z"}],
        )
        row = rows["7003"]
        assert "statcast_team" not in row.families_available
        assert "statcast_team" in row.families_missing
        assert any("statcast_team:post_pitch_source" in t for t in row.temporal_rejections)
        assert row.feature_vector["awayTeamXwoba"] is None
        assert row.feature_vector["missing_awayTeamXwoba"] == 1
    finally:
        os.unlink(db_path)


def test_extract_rejects_missing_first_pitch():
    """No first pitch known -> cannot prove safety -> family dropped."""
    db_path = _make_db()
    try:
        conn = sqlite3.connect(db_path)
        _write_snapshot(conn, "7004", "statcast_team", "2026-07-21", _statcast_payload())
        conn.close()
        rows = build_candidate_dataset(
            db_path,
            game_rows=[{"game_pk": "7004", "date_ymd": "2026-07-21",
                        "as_of_utc": "2026-07-21T17:00:00Z",
                        "first_pitch_utc": None}],
        )
        row = rows["7004"]
        assert "statcast_team" in row.families_missing
        assert any("missing_first_pitch" in t for t in row.temporal_rejections)
    finally:
        os.unlink(db_path)


# ---------- Insufficient sample stays null (BvP) ----------

def test_extract_carries_bvp_null_when_below_floor():
    """BvP payload below MIN_PLATE_APPEARANCES is null at collection; extractor
    carries the null (it does NOT synthesize a value)."""
    db_path = _make_db()
    try:
        conn = sqlite3.connect(db_path)
        _write_snapshot(conn, "7005", "bvp", "2026-07-21", {
            "as_of_utc": "2026-07-21T17:00:00Z",
            "away": None,  # below floor -> null at collection
            "home": {"ops": 0.70, "plate_appearances": 60},
        })
        conn.close()
        rows = build_candidate_dataset(
            db_path,
            game_rows=[{"game_pk": "7005", "date_ymd": "2026-07-21",
                        "as_of_utc": "2026-07-21T17:00:00Z",
                        "first_pitch_utc": "2026-07-21T23:05:00Z"}],
        )
        v = rows["7005"].feature_vector
        assert v["awayLineupBvpOps"] is None
        assert v["homeLineupBvpOps"] == 0.70
    finally:
        os.unlink(db_path)


# ---------- Determinism / hash parity ----------

def test_extract_hash_is_deterministic_across_calls():
    db_path = _make_db()
    try:
        conn = sqlite3.connect(db_path)
        _write_snapshot(conn, "7006", "statcast_team", "2026-07-21", _statcast_payload())
        conn.close()
        game_row = {"game_pk": "7006", "date_ymd": "2026-07-21",
                    "as_of_utc": "2026-07-21T17:00:00Z",
                    "first_pitch_utc": "2026-07-21T23:05:00Z"}
        r1 = build_candidate_dataset(db_path, game_rows=[game_row])["7006"]
        r2 = build_candidate_dataset(db_path, game_rows=[game_row])["7006"]
        assert r1.feature_vector_hash == r2.feature_vector_hash
    finally:
        os.unlink(db_path)


# ---------- Coverage summary ----------

def test_coverage_summary_reports_available_and_missing():
    db_path = _make_db()
    try:
        conn = sqlite3.connect(db_path)
        for gpk in ["8001", "8002"]:
            _write_snapshot(conn, gpk, "statcast_team", "2026-07-21", _statcast_payload())
        _write_snapshot(conn, "8001", "pitch_arsenal", "2026-07-21", _arsenal_payload())
        conn.close()
        rows = build_candidate_dataset(
            db_path,
            game_rows=[
                {"game_pk": gpk, "date_ymd": "2026-07-21",
                 "as_of_utc": "2026-07-21T17:00:00Z",
                 "first_pitch_utc": "2026-07-21T23:05:00Z"}
                for gpk in ["8001", "8002"]
            ],
        )
        summary = candidate_coverage_summary(rows)
        assert summary["row_count"] == 2
        assert summary["families"]["statcast_team"]["available"] == 2
        assert summary["families"]["statcast_team"]["coverage_pct"] == 100.0
        assert summary["families"]["pitch_arsenal"]["available"] == 1
        assert summary["families"]["pitch_arsenal"]["coverage_pct"] == 50.0
    finally:
        os.unlink(db_path)


def test_coverage_summary_empty():
    assert candidate_coverage_summary({}) == {"row_count": 0, "families": {}, "temporal_rejections": {}}
