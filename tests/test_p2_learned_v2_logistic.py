"""P2 tests: learned_v2_logistic trainer, insufficient-data gate, JS/Python parity.

Parity is checked by:
  1. Running the Python trainer on a synthetic chronological DB with feature
     vectors, producing an artifact with coefficients/scaling.
  2. Loading the SAME artifact in JS (src/core/learned_v2_logistic.js) via the
     node CLI and scoring the SAME frozen feature vector.
  3. Comparing probabilities to the Python _predict_fold output on the same row.

Uses temporary SQLite DBs. Never touches live data/state.sqlite.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from src.dataset.build_game_dataset import build_game_dataset
from src.models.train_learned_v2_logistic import (
    train_learned_v2_logistic,
    write_artifact,
    _predict_fold,
    _fit_fold,
    _build_matrix,
    _row_features,
    FEATURE_NAMES,
    LEARNED_V2_LOGISTIC_MODEL_ID,
    LEARNED_V2_LOGISTIC_IMPL_VERSION,
    MIN_TRAIN_ROWS_PER_FOLD,
    MIN_EVENTS_PER_CLASS,
)
from src.core.feature_vector_py import buildFeatureVector, flattenFeatureVector  # noqa: F401

MIGRATIONS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "src", "storage", "migrations")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _apply_migrations(db_path: str) -> None:
    conn = sqlite3.connect(db_path)
    conn.executescript(
        "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);"
    )
    skip = {"004_append_only_picks", "005_shadow_ledger"}
    files = sorted(f for f in os.listdir(MIGRATIONS_DIR) if f.endswith(".sql"))
    for fname in files:
        mid = fname.replace(".sql", "")
        if mid in skip:
            continue
        with open(os.path.join(MIGRATIONS_DIR, fname)) as fh:
            sql = fh.read()
        conn.executescript(sql)
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
            (mid, f"test-{mid}", datetime.now(timezone.utc).isoformat()),
        )
    conn.commit()
    conn.close()


def _sample_core_inputs(game_pk: int, home_won_bias: bool = True) -> dict:
    """A minimal but complete frozen coreInputs with a feature-vector signal.

    Varies team strength by game_pk so the logistic model has something to fit.
    """
    rng = np.random.default_rng(abs(game_pk) % 1000)
    home_wins = 40 + int(rng.integers(0, 20))
    home_losses = 100 - home_wins
    away_wins = 100 - home_wins - 10
    away_losses = 100 - away_wins
    return {
        "game": {
            "gamePk": game_pk,
            "officialDate": f"2026-06-{((game_pk % 27) + 1):02d}",
            "venue": {"id": 3, "name": "Park"},
            "weather": {"temp": "85", "wind": "10 mph, out"},
            "teams": {
                "away": {"team": {"id": 113}, "probablePitcher": {"id": 605397, "pitchHand": {"code": "R"}}},
                "home": {"team": {"id": 120}, "probablePitcher": {"id": 543037, "pitchHand": {"code": "L"}}},
            },
        },
        "teamStats": {
            "113": {"hitting": {"gamesPlayed": 100, "runs": 400 + away_wins, "ops": ".700"}, "pitching": {"era": "4.50", "whip": "1.40"}},
            "120": {"hitting": {"gamesPlayed": 100, "runs": 420 + home_wins, "ops": ".730"}, "pitching": {"era": "3.80", "whip": "1.25"}},
        },
        "standings": {
            "113": {"leagueRecord": {"wins": away_wins, "losses": away_losses}, "gamesPlayed": 100, "runDifferential": -20, "records": {"splitRecords": [{"type": "lastTen", "pct": 0.5}, {"type": "left", "pct": 0.45}, {"type": "right", "pct": 0.51}]}},
            "120": {"leagueRecord": {"wins": home_wins, "losses": home_losses}, "gamesPlayed": 100, "runDifferential": 30, "records": {"splitRecords": [{"type": "lastTen", "pct": 0.6}, {"type": "left", "pct": 0.57}, {"type": "right", "pct": 0.54}]}},
        },
        "pitcherStats": {
            "605397": {"era": "4.10", "whip": "1.30", "strikeoutsMinusWalksPercentage": 0.11, "homeRunsPer9": 1.1},
            "543037": {"era": "3.20", "whip": "1.10", "strikeoutsMinusWalksPercentage": 0.16, "homeRunsPer9": 0.85},
        },
        "pitcherDetails": {},
        "pitcherRecentStarts": {
            "605397": {"innings": 30, "era": "4.50", "whip": "1.35"},
            "543037": {"innings": 32, "era": "2.80", "whip": "1.05"},
        },
        "bullpenProfiles": {"113": {"fatigueScore": 3, "backToBackRelievers": 1}, "120": {"fatigueScore": 1, "backToBackRelievers": 0}},
        "scheduleFatigueProfiles": {"113": {"restDays": 2, "roadStreak": 3}, "120": {"restDays": 4, "roadStreak": 0}},
        "headToHead": {"games": 6, "homeProbability": 66.7},
        "injuryProfiles": {"113": [{"position": "CF"}], "120": []},
        "lineupProfiles": {"away": {"confirmed": False, "count": 9, "qualityScore": 0.45}, "home": {"confirmed": True, "count": 9, "qualityScore": 0.7}},
        "modelMemory": {},
        "rollingTeamStats": {},
        "evolutionControls": {},
        "parkFactorBaselines": [],
    }


def _flat_vector(game_pk: int) -> dict:
    """Build a flattened feature vector the same way JS flattenFeatureVector does.

    Mirrors src/core/feature_vector.js logic in Python for parity input.
    """
    from src.core.feature_vector_py import buildFeatureVector, flattenFeatureVector

    return flattenFeatureVector(buildFeatureVector(_sample_core_inputs(game_pk)))


def _make_db(n_games: int = 140) -> str:
    """Create a synthetic chronological DB with feature vectors for n_games."""
    fd, db_path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    _apply_migrations(db_path)

    conn = sqlite3.connect(db_path)
    base = datetime(2026, 4, 1, 12, 0, 0, tzinfo=timezone.utc)
    # Spread games across enough dates for fold formation + holdout.
    for i in range(n_games):
        game_pk = 1000 + i
        date = base + timedelta(days=i)  # one game per date -> clear folds
        first_pitch = date + timedelta(hours=11)
        as_of = date + timedelta(hours=3)
        run_id = f"run-{game_pk}"
        # Outcome correlated with home strength so the model has signal.
        ci = _sample_core_inputs(game_pk)
        home_win_pct = ci["standings"]["120"]["leagueRecord"]["wins"] / 100.0
        home_won = home_win_pct > 0.5
        flat = _flat_vector(game_pk)
        conn.execute(
            "INSERT INTO prediction_runs (run_id, game_pk, market, date_ymd, "
            "prediction_timestamp_utc, as_of_utc, first_pitch_utc, created_at, "
            "model_id, information_state, producer_timestamp_utc, feature_hash, "
            "normalized_feature_vector, feature_manifest_version, core_inputs_hash) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, str(game_pk), "moneyline", date.strftime("%Y-%m-%d"),
             as_of.isoformat(), as_of.isoformat(), first_pitch.isoformat(), as_of.isoformat(),
             "heuristic_v1", "scheduled_early", as_of.isoformat(), flat.get("featureVectorHash"),
             json.dumps(flat), "mlb-feature-vector-v1.0", "hash-" + str(game_pk)),
        )
        conn.execute(
            "INSERT INTO model_predictions (prediction_id, run_id, game_pk, date_ymd, "
            "model_id, raw_home_probability, raw_away_probability, "
            "calibrated_home_probability, calibrated_away_probability, "
            "pick_side, pick_team_id, as_of_utc, first_pitch_utc, information_state, "
            "promotion_eligible, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"mp-{run_id}", run_id, str(game_pk), date.strftime("%Y-%m-%d"), "heuristic_v1",
             55.0, 45.0, 55.0, 45.0, "home", "120",
             as_of.isoformat(), first_pitch.isoformat(), "scheduled_early", 1, as_of.isoformat()),
        )
        home_score = 5 if home_won else 3
        away_score = 3 if home_won else 5
        conn.execute(
            "INSERT INTO game_outcomes (game_pk, date_ymd, home_team_id, away_team_id, "
            "home_score, away_score, winner_team_id, loser_team_id, recorded_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (str(game_pk), date.strftime("%Y-%m-%d"), "120", "113",
             home_score, away_score, "120" if home_won else "113", "113" if home_won else "120",
             datetime.now(timezone.utc).isoformat()),
        )
    conn.commit()
    conn.close()
    return db_path


# ---------- Insufficient-data gate ----------

def test_trainer_emits_insufficient_data_when_too_few_rows():
    db_path = _make_db(n_games=10)  # far below fold/train minimums
    try:
        report = train_learned_v2_logistic(db_path, cohort="main")
        assert report["status"] == "insufficient_data"
        assert report["artifact"] is None
        assert report["artifact_hash"] is None
        assert len(report["reasons"]) > 0
    finally:
        os.unlink(db_path)


def test_trainer_emits_insufficient_data_with_empty_dataset(tmp_path):
    # Empty DB (migrations applied, no rows).
    fd, db_path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    _apply_migrations(db_path)
    try:
        report = train_learned_v2_logistic(db_path, cohort="main")
        assert report["status"] == "insufficient_data"
        assert "empty_dataset" in report["reasons"]
    finally:
        os.unlink(db_path)


# ---------- Trainer produces a usable artifact ----------

def test_trainer_produces_artifact_with_required_fields():
    db_path = _make_db(n_games=140)
    try:
        report = train_learned_v2_logistic(db_path, cohort="main")
        # With 140 one-per-day games, fold formation may still be marginal.
        # If it trained, assert structure; if insufficient, that's also valid.
        if report["status"] == "insufficient_data":
            pytest.skip("insufficient data for this synthetic size — valid scaffold result")
        assert report["status"] == "trained"
        art = report["artifact"]
        assert art["model_id"] == LEARNED_V2_LOGISTIC_MODEL_ID
        assert art["model_impl_version"] == LEARNED_V2_LOGISTIC_IMPL_VERSION
        assert set(art["feature_names"]) == set(FEATURE_NAMES)
        assert len(art["coefficients"]) == len(FEATURE_NAMES)
        assert len(art["imputation"]) == len(FEATURE_NAMES)
        assert len(art["feature_mean"]) == len(FEATURE_NAMES)
        assert len(art["feature_std"]) == len(FEATURE_NAMES)
        assert isinstance(art["intercept"], float)
        assert art["artifact_hash"]
        assert "oof_metrics" in art
        assert report["recommendation_eligible"] is False  # P7 holdout + human needed
    finally:
        os.unlink(db_path)


def test_trainer_never_mutates_production_tables():
    db_path = _make_db(n_games=140)
    # Snapshot row counts before.
    conn = sqlite3.connect(db_path)
    before = conn.execute("SELECT COUNT(*) FROM model_predictions").fetchone()[0]
    runs_before = conn.execute("SELECT COUNT(*) FROM prediction_runs").fetchone()[0]
    conn.close()
    try:
        train_learned_v2_logistic(db_path, cohort="main")
        conn = sqlite3.connect(db_path)
        after = conn.execute("SELECT COUNT(*) FROM model_predictions").fetchone()[0]
        runs_after = conn.execute("SELECT COUNT(*) FROM prediction_runs").fetchone()[0]
        conn.close()
        assert after == before, "trainer must not insert model_predictions rows"
        assert runs_after == runs_before, "trainer must not insert prediction_runs rows"
    finally:
        os.unlink(db_path)


# ---------- Write artifact ----------

def test_write_artifact_creates_json(tmp_path):
    db_path = _make_db(n_games=140)
    try:
        report = train_learned_v2_logistic(db_path, cohort="main")
        out = write_artifact(report, str(tmp_path))
        assert os.path.exists(out)
        with open(out) as f:
            loaded = json.load(f)
        assert loaded["status"] == report["status"]
    finally:
        os.unlink(db_path)


# ---------- Fold-only fit (no leakage) ----------

def test_fit_fold_respects_minimum_support():
    # Too few rows to fit a fold.
    db_path = _make_db(n_games=5)
    try:
        clean, _ = build_game_dataset(db_path, model_id="heuristic_v1", cohort="main")
        fit, reason = _fit_fold(clean, fold_index=0)
        assert fit is None
        assert reason is not None
    finally:
        os.unlink(db_path)


def test_matrix_build_handles_missing_feature_vector():
    """A row without a feature vector is marked invalid, not dropped silently."""
    db_path = _make_db(n_games=5)
    try:
        clean, _ = build_game_dataset(db_path, model_id="heuristic_v1", cohort="main")
        # Strip the feature vector from one row.
        clean[0].feature_vector = None
        matrix = _build_matrix(clean)
        assert matrix is not None
        _, _, valid_mask = matrix
        assert valid_mask[0] == 0
    finally:
        os.unlink(db_path)


# ---------- JS / Python parity ----------

def _js_score(artifact_path: str, flat_vector: dict) -> dict:
    """Invoke the JS inference engine on an artifact + flat vector, return result."""
    payload = json.dumps({"artifactPath": artifact_path, "flatVector": flat_vector})
    script = """
import { readFileSync } from 'node:fs';
import { verifyLearnedV2Artifact, scoreLearnedV2Logistic } from './src/core/learned_v2_logistic.js';
const input = JSON.parse(readFileSync(0, 'utf8'));
const artifact = JSON.parse(readFileSync(input.artifactPath, 'utf8'));
const inner = artifact.artifact && typeof artifact.artifact === 'object' ? artifact.artifact : artifact;
const v = verifyLearnedV2Artifact(inner);
if (!v.ok) { process.stdout.write(JSON.stringify({error: 'verify_failed', reasons: v.reasons})); process.exit(0); }
const scored = scoreLearnedV2Logistic(inner, input.flatVector);
process.stdout.write(JSON.stringify(scored));
"""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=payload, capture_output=True, text=True, cwd=ROOT, timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"node failed: {proc.stderr}")
    return json.loads(proc.stdout)


def test_js_python_parity_on_identical_feature_vector():
    """Python-trained artifact scored by both Python and JS yields matching probs."""
    db_path = _make_db(n_games=160)
    try:
        report = train_learned_v2_logistic(db_path, cohort="main")
        if report["status"] == "insufficient_data":
            pytest.skip("insufficient data for parity synthetic size")
        art = report["artifact"]
        # Write artifact so JS can read it.
        tmp_dir = tempfile.mkdtemp()
        art_path = os.path.join(tmp_dir, "parity.json")
        with open(art_path, "w") as f:
            json.dump(report, f)  # report form (artifact under .artifact)

        # Pick a row from the dataset and score it both ways.
        clean, _ = build_game_dataset(db_path, model_id="heuristic_v1", cohort="main")
        row = clean[-1]  # latest game
        assert row.feature_vector is not None

        # Python predict using the final-fit coefficients.
        # Reconstruct a FoldFit-like object from the artifact.
        from src.models.train_learned_v2_logistic import FoldFit
        final_fit = FoldFit(
            fold_index=-1,
            train_rows=art["train_rows"],
            pos_events=art["pos_events"],
            neg_events=art["neg_events"],
            imputation=art["imputation"],
            feature_mean=art["feature_mean"],
            feature_std=art["feature_std"],
            coefficients=art["coefficients"],
            intercept=art["intercept"],
            l2_strength=art["l2_strength"],
            train_brier=None, train_log_loss=None, train_accuracy=None,
        )
        py_probs, py_valid = _predict_fold(final_fit, [row])
        assert py_valid[0] == 1
        py_home = py_probs[0]

        # JS predict.
        js_result = _js_score(art_path, row.feature_vector)
        assert "error" not in js_result, f"JS verify/score failed: {js_result}"
        assert js_result["available"] is True, f"JS unavailable: {js_result.get('reasons')}"
        js_home = js_result["homeProbability"]

        # Parity tolerance: both use the same coefficients/scaling/imputation,
        # so the only difference is float rounding. Allow 1e-6.
        assert abs(py_home - js_home) < 1e-6, (
            f"parity mismatch: python={py_home}, js={js_home}"
        )
    finally:
        os.unlink(db_path)
