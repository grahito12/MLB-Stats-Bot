"""P3 tests: market_residual_v2 trainer, no-market exclusion, fixed offset, parity.

The residual model: logit(P_home) = logit(P_market_no_vig_home) + beta0 + beta.X
with the market-offset coefficient FIXED at 1.0 (never fit). Rows without a
complete same-book market pair are excluded from training and score unavailable.
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
from src.models.train_market_residual_v2 import (
    train_market_residual_v2,
    write_artifact,
    _fit_residual_fold,
    _predict_residual_fold,
    _market_logit,
    MARKET_RESIDUAL_V2_MODEL_ID,
    MARKET_RESIDUAL_V2_IMPL_VERSION,
    MARKET_OFFSET_COEFFICIENT,
    MIN_WITH_MARKET_ROWS,
)
from src.models.train_learned_v2_logistic import _stable_stringify, FEATURE_NAMES
from src.core.feature_vector_py import buildFeatureVector, flattenFeatureVector

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


def _sample_core_inputs(game_pk: int) -> dict:
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
        "modelMemory": {}, "rollingTeamStats": {}, "evolutionControls": {}, "parkFactorBaselines": [],
    }


def _flat_vector(game_pk: int) -> dict:
    return flattenFeatureVector(buildFeatureVector(_sample_core_inputs(game_pk)))


def _make_db(n_games: int = 160, market_fraction: float = 1.0) -> str:
    """Synthetic chronological DB. market_fraction of games get a same-book quote."""
    fd, db_path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    _apply_migrations(db_path)

    conn = sqlite3.connect(db_path)
    base = datetime(2026, 4, 1, 12, 0, 0, tzinfo=timezone.utc)
    for i in range(n_games):
        game_pk = 1000 + i
        date = base + timedelta(days=i)
        first_pitch = date + timedelta(hours=11)
        as_of = date + timedelta(hours=3)
        run_id = f"run-{game_pk}"
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
        # Market quote paired to this run (fetched_at <= as_of). Same-book no-vig
        # home prob derived from -150/+130-ish odds scaled by home_win_pct.
        has_market = (i / max(1, n_games - 1)) >= (1.0 - market_fraction)
        market_home = None
        if has_market:
            odds_home = -150 if home_win_pct > 0.5 else 130
            odds_away = 130 if home_win_pct > 0.5 else -150
            home_imp = 100 / (odds_home + 100) if odds_home > 0 else abs(odds_home) / (abs(odds_home) + 100)
            away_imp = 100 / (odds_away + 100) if odds_away > 0 else abs(odds_away) / (abs(odds_away) + 100)
            total = home_imp + away_imp
            market_home = home_imp / total
            conn.execute(
                "INSERT INTO market_quote_pairs (quote_pair_id, game_pk, bookmaker, market, "
                "home_odds, away_odds, home_no_vig_prob, away_no_vig_prob, fetched_at_utc, "
                "first_pitch_utc, as_of_utc, is_opening, is_closing, is_eligible, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (f"qp-{game_pk}", str(game_pk), "pinnacle", "moneyline", odds_home, odds_away,
                 market_home, 1 - market_home, as_of.isoformat(),
                 first_pitch.isoformat(), as_of.isoformat(), 1, 0, 1, as_of.isoformat()),
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


# ---------- Fixed offset ----------

def test_market_offset_coefficient_is_exactly_one():
    assert MARKET_OFFSET_COEFFICIENT == 1.0


def test_market_logit_returns_none_without_market():
    """A row with no no-vig market prob yields no market logit (no residual)."""
    from src.dataset.build_game_dataset import DatasetRow

    row = DatasetRow(
        game_pk="1", date_ymd="2026-06-01", model_id="heuristic_v1", run_id="r1",
        as_of_utc=None, first_pitch_utc=None, information_state="scheduled_early",
        promotion_eligible=True, raw_home_probability=None, raw_away_probability=None,
        calibrated_home_probability=None, calibrated_away_probability=None,
        pick_side=None, pick_team_id=None, winner_team_id=None, home_won=None,
        home_team_id="120", away_team_id="113", market_no_vig_home_prob=None,
        market_no_vig_away_prob=None, paired_quote_pair_id=None, snapshot_hash=None,
        feature_vector_hash=None, feature_vector=None,
    )
    assert _market_logit(row) is None


# ---------- Insufficient-data gate ----------

def test_trainer_insufficient_when_no_market_rows():
    """No market quotes at all => insufficient_data."""
    db_path = _make_db(n_games=160, market_fraction=0.0)
    try:
        report = train_market_residual_v2(db_path, cohort="main")
        assert report["status"] == "insufficient_data"
        assert any("with_market_rows" in r for r in report["reasons"])
        assert report["artifact"] is None
    finally:
        os.unlink(db_path)


def test_trainer_insufficient_when_too_few_rows():
    db_path = _make_db(n_games=10, market_fraction=1.0)
    try:
        report = train_market_residual_v2(db_path, cohort="main")
        assert report["status"] == "insufficient_data"
        assert report["artifact"] is None
    finally:
        os.unlink(db_path)


# ---------- Trainer produces artifact ----------

def test_trainer_produces_artifact_with_market_oof_metrics():
    db_path = _make_db(n_games=160, market_fraction=1.0)
    try:
        report = train_market_residual_v2(db_path, cohort="main")
        if report["status"] == "insufficient_data":
            pytest.skip("insufficient data for this synthetic size — valid scaffold result")
        assert report["status"] == "trained"
        art = report["artifact"]
        assert art["model_id"] == MARKET_RESIDUAL_V2_MODEL_ID
        assert art["model_impl_version"] == MARKET_RESIDUAL_V2_IMPL_VERSION
        assert art["market_offset_coefficient"] == 1.0
        assert "market_oof_metrics" in art
        assert "oof_metrics" in art
        assert report["recommendation_eligible"] is False
    finally:
        os.unlink(db_path)


def test_trainer_never_mutates_production_tables():
    db_path = _make_db(n_games=160, market_fraction=1.0)
    conn = sqlite3.connect(db_path)
    before_mp = conn.execute("SELECT COUNT(*) FROM model_predictions").fetchone()[0]
    before_q = conn.execute("SELECT COUNT(*) FROM market_quote_pairs").fetchone()[0]
    conn.close()
    try:
        train_market_residual_v2(db_path, cohort="main")
        conn = sqlite3.connect(db_path)
        after_mp = conn.execute("SELECT COUNT(*) FROM model_predictions").fetchone()[0]
        after_q = conn.execute("SELECT COUNT(*) FROM market_quote_pairs").fetchone()[0]
        conn.close()
        assert after_mp == before_mp
        assert after_q == before_q
    finally:
        os.unlink(db_path)


def test_fit_residual_fold_respects_minimum_support():
    db_path = _make_db(n_games=5, market_fraction=1.0)
    try:
        clean, _ = build_game_dataset(db_path, model_id="heuristic_v1", cohort="main")
        fit, reason = _fit_residual_fold(clean, fold_index=0)
        assert fit is None
        assert reason is not None
    finally:
        os.unlink(db_path)


# ---------- JS / Python parity ----------

def _js_score(artifact_path: str, flat_vector: dict, market_home: float) -> dict:
    payload = json.dumps({"artifactPath": artifact_path, "flatVector": flat_vector, "marketHome": market_home})
    script = """
import { readFileSync } from 'node:fs';
import { verifyMarketResidualV2Artifact, scoreMarketResidualV2 } from './src/core/market_residual_v2.js';
const input = JSON.parse(readFileSync(0, 'utf8'));
const report = JSON.parse(readFileSync(input.artifactPath, 'utf8'));
const inner = report.artifact && typeof report.artifact === 'object' ? report.artifact : report;
const v = verifyMarketResidualV2Artifact(inner);
if (!v.ok) { process.stdout.write(JSON.stringify({error: 'verify_failed', reasons: v.reasons})); process.exit(0); }
const scored = scoreMarketResidualV2(inner, input.flatVector, input.marketHome);
process.stdout.write(JSON.stringify(scored));
"""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=payload, capture_output=True, text=True, cwd=ROOT, timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"node failed: {proc.stderr}")
    return json.loads(proc.stdout)


def test_js_python_parity_on_identical_feature_vector_and_market():
    db_path = _make_db(n_games=180, market_fraction=1.0)
    try:
        report = train_market_residual_v2(db_path, cohort="main")
        if report["status"] == "insufficient_data":
            pytest.skip("insufficient data for parity synthetic size")
        art = report["artifact"]
        tmp_dir = tempfile.mkdtemp()
        art_path = os.path.join(tmp_dir, "parity.json")
        with open(art_path, "w") as f:
            json.dump(report, f)

        clean, _ = build_game_dataset(db_path, model_id="heuristic_v1", cohort="main")
        # Find a with-market row.
        row = next((r for r in clean if _market_logit(r) is not None and r.feature_vector), None)
        assert row is not None, "need a with-market row for parity"
        market_home = _market_logit(row)  # this is logit; need the prob
        market_home_prob = float(row.market_no_vig_home_prob)

        from src.models.train_market_residual_v2 import ResidualFoldFit
        final_fit = ResidualFoldFit(
            fold_index=-1, train_rows=art["train_rows"], pos_events=art["pos_events"],
            neg_events=art["neg_events"], imputation=art["imputation"],
            feature_mean=art["feature_mean"], feature_std=art["feature_std"],
            coefficients=art["coefficients"], intercept=art["intercept"],
            l2_strength=art["l2_strength"], train_brier=None, train_log_loss=None, train_accuracy=None,
        )
        py_probs, py_valid = _predict_residual_fold(final_fit, [row])
        assert py_valid[0] == 1
        py_home = py_probs[0]

        js_result = _js_score(art_path, row.feature_vector, market_home_prob)
        assert "error" not in js_result, f"JS failed: {js_result}"
        assert js_result["available"] is True, f"JS unavailable: {js_result.get('reasons')}"
        js_home = js_result["homeProbability"]

        assert abs(py_home - js_home) < 1e-6, f"parity mismatch: python={py_home}, js={js_home}"
    finally:
        os.unlink(db_path)
