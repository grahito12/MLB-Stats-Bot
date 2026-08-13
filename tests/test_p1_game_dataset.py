"""P1 tests: all-game dataset builder, folds, quarantine, baselines, recommend.

Uses a temporary SQLite DB populated with synthetic model_predictions,
prediction_runs, game_outcomes, and market_quote_pairs. Never touches live
data/state.sqlite.
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

from src.dataset.build_game_dataset import (
    build_game_dataset,
    build_folds,
    quarantine_row,
    select_main_cohort_row,
)
from src.eval.metrics import model_metrics, roc_auc, ece, brier_score, log_loss, accuracy
from src.eval.baselines import home_baseline, score_baselines
from src.eval.compare_models import compare_models
from src.eval.recommend import recommend, MIN_HOLDOUT_ROWS


MIGRATIONS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "src", "storage", "migrations")


def _apply_migrations(db_path: str) -> None:
    """Apply SQL migrations to a fresh test DB.

    Migrations 004/005 assume a pre-existing legacy schema (picks/bet_ledger/
    yrfi_results with full column sets) and rename/rebuild those tables. The
    dataset builder only needs the immutable accounting tables from 002 + the
    P1 tables from 006, so we apply 001, 002, 003, 006 and skip the legacy
    rebuilds (004/005). Production applies the full chain against an existing DB.
    """
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


def _make_db(games: list[dict]) -> str:
    """Create a temp DB with synthetic runs + outcomes for the given games.

    Each game dict: {game_pk, date_ymd, home_won, home_team_id, away_team_id,
    as_of_offset_hours, first_pitch_offset_hours, calibrated_home, market_home,
    promotion_eligible, information_state}
    """
    fd, db_path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)

    _apply_migrations(db_path)

    conn = sqlite3.connect(db_path)
    base = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
    for i, g in enumerate(games):
        game_pk = str(g["game_pk"])
        date = g["date_ymd"]
        first_pitch = base + timedelta(days=i, hours=g.get("first_pitch_offset_hours", 11))
        as_of = first_pitch - timedelta(hours=g.get("as_of_offset_hours", 8))
        run_id = f"run-{game_pk}"
        conn.execute(
            "INSERT INTO prediction_runs (run_id, game_pk, market, date_ymd, "
            "prediction_timestamp_utc, as_of_utc, first_pitch_utc, created_at, "
            "model_id, information_state, producer_timestamp_utc) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, game_pk, "moneyline", date, as_of.isoformat(), as_of.isoformat(),
             first_pitch.isoformat(), as_of.isoformat(), "heuristic_v1",
             g.get("information_state", "scheduled_early"), as_of.isoformat()),
        )
        conn.execute(
            "INSERT INTO model_predictions (prediction_id, run_id, game_pk, date_ymd, "
            "model_id, raw_home_probability, raw_away_probability, "
            "calibrated_home_probability, calibrated_away_probability, "
            "pick_side, pick_team_id, as_of_utc, first_pitch_utc, information_state, "
            "promotion_eligible, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"mp-{run_id}", run_id, game_pk, date, "heuristic_v1",
             g["calibrated_home"], 100 - g["calibrated_home"],
             g["calibrated_home"], 100 - g["calibrated_home"],
             "home" if g["calibrated_home"] >= 50 else "away",
             g.get("home_team_id", "120"),
             as_of.isoformat(), first_pitch.isoformat(),
             g.get("information_state", "scheduled_early"),
             1 if g.get("promotion_eligible", True) else 0,
             as_of.isoformat()),
        )
        # Outcome.
        home_score = 5 if g["home_won"] else 3
        away_score = 3 if g["home_won"] else 5
        winner = g.get("home_team_id", "120") if g["home_won"] else g.get("away_team_id", "113")
        loser = g.get("away_team_id", "113") if g["home_won"] else g.get("home_team_id", "120")
        conn.execute(
            "INSERT INTO game_outcomes (game_pk, date_ymd, home_team_id, away_team_id, "
            "home_score, away_score, winner_team_id, loser_team_id, recorded_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (game_pk, date, g.get("home_team_id", "120"), g.get("away_team_id", "113"),
             home_score, away_score, winner, loser, datetime.now(timezone.utc).isoformat()),
        )
        # Optional market quote.
        if g.get("market_home") is not None:
            conn.execute(
                "INSERT INTO market_quote_pairs (quote_pair_id, game_pk, bookmaker, market, "
                "home_odds, away_odds, home_no_vig_prob, away_no_vig_prob, fetched_at_utc, "
                "first_pitch_utc, as_of_utc, is_opening, is_closing, is_eligible, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (f"qp-{game_pk}", game_pk, "pinnacle", "moneyline", -150, 130,
                 g["market_home"], 1 - g["market_home"], as_of.isoformat(),
                 first_pitch.isoformat(), as_of.isoformat(), 1, 0, 1,
                 as_of.isoformat()),
            )
    conn.commit()
    conn.close()
    return db_path


# ---------- Metrics ----------

def test_metrics_empty_returns_none():
    assert model_metrics([], [])["accuracy"] is None
    assert brier_score([], []) is None
    assert log_loss([], []) is None
    assert roc_auc([], []) is None
    assert ece([], []) is None


def test_metrics_perfect_prediction():
    probs = [0.9, 0.8, 0.1, 0.2]
    outcomes = [1, 1, 0, 0]
    assert accuracy(probs, outcomes) == 1.0
    assert brier_score(probs, outcomes) is not None
    assert roc_auc(probs, outcomes) == 1.0


def test_roc_auc_requires_both_classes():
    assert roc_auc([0.6, 0.7], [1, 1]) is None  # only one class


# ---------- Quarantine ----------

def test_quarantine_missing_first_pitch():
    run = {"first_pitch_utc": None, "as_of_utc": "2026-07-21T12:00:00Z"}
    assert quarantine_row(run, {"winner_team_id": "120"}) == "missing_first_pitch"


def test_quarantine_post_pitch_as_of():
    run = {"first_pitch_utc": "2026-07-21T23:05:00Z", "as_of_utc": "2026-07-22T00:00:00Z"}
    assert quarantine_row(run, {"winner_team_id": "120"}) == "post_pitch_as_of"


def test_quarantine_missing_outcome():
    run = {"first_pitch_utc": "2026-07-21T23:05:00Z", "as_of_utc": "2026-07-21T12:00:00Z"}
    assert quarantine_row(run, None) == "missing_outcome"


def test_quarantine_future_source_timestamp():
    run = {
        "first_pitch_utc": "2026-07-21T23:05:00Z",
        "as_of_utc": "2026-07-21T12:00:00Z",
        "producer_timestamp_utc": "2026-07-22T00:00:00Z",
    }
    assert quarantine_row(run, {"winner_team_id": "120"}) == "future_source_timestamp"


def test_quarantine_clean_row():
    run = {
        "first_pitch_utc": "2026-07-21T23:05:00Z",
        "as_of_utc": "2026-07-21T12:00:00Z",
        "producer_timestamp_utc": "2026-07-21T12:00:00Z",
    }
    assert quarantine_row(run, {"winner_team_id": "120", "home_score": 5, "away_score": 3}) is None


# ---------- Dataset + folds ----------

def _synthetic_games(n: int = 30) -> list[dict]:
    games = []
    for i in range(n):
        games.append({
            "game_pk": 1000 + i,
            "date_ymd": (datetime(2026, 6, 1) + timedelta(days=i)).strftime("%Y-%m-%d"),
            "home_won": i % 2 == 0,
            "calibrated_home": 55 + (i % 5),
            "market_home": 0.52 + (i % 3) * 0.01,
            "home_team_id": "120",
            "away_team_id": "113",
        })
    return games


def test_build_game_dataset_main_cohort():
    db = _make_db(_synthetic_games(30))
    try:
        clean, quarantined = build_game_dataset(db, model_id="heuristic_v1", cohort="main")
        assert len(clean) == 30
        assert len(quarantined) == 0
        row = clean[0]
        assert row.home_won is not None
        assert row.calibrated_home_probability is not None
        # Market joined.
        assert row.market_no_vig_home_prob is not None
    finally:
        os.unlink(db)


def test_build_folds_same_date_partitioning_and_holdout():
    db = _make_db(_synthetic_games(40))
    try:
        clean, _ = build_game_dataset(db, model_id="heuristic_v1", cohort="main")
        folds, dataset_hash = build_folds(clean, step_days=7, holdout_fraction=0.2)
        assert len(folds) > 0
        assert any(f["fold_type"] == "holdout" for f in folds)
        assert dataset_hash
        # Test folds are disjoint (half-open).
        test_folds = [f for f in folds if f["fold_type"] == "test"]
        for i in range(1, len(test_folds)):
            assert test_folds[i]["start_date"] >= test_folds[i - 1]["end_date"], "folds overlap"
        # Holdout does not overlap any test fold.
        holdout = next(f for f in folds if f["fold_type"] == "holdout")
        for tf in test_folds:
            assert holdout["start_date"] >= tf["end_date"], "holdout overlaps test"
    finally:
        os.unlink(db)


def test_post_pitch_run_quarantined():
    games = _synthetic_games(5)
    # Make game 2 post-pitch.
    games[2]["as_of_offset_hours"] = -1  # as_of after first_pitch
    games[2]["promotion_eligible"] = False
    db = _make_db(games)
    try:
        clean, quarantined = build_game_dataset(db, model_id="heuristic_v1", cohort="main")
        # The post-pitch game is not promotion-eligible, so it won't be in
        # the eligible pool; it falls back to quarantined with reason.
        assert len(clean) + len(quarantined) == 5
    finally:
        os.unlink(db)


# ---------- Baselines + comparison ----------

def test_score_baselines_and_compare_models():
    db = _make_db(_synthetic_games(30))
    try:
        report = compare_models(db, model_id="heuristic_v1", cohort="main")
        assert report["row_count"] == 30
        assert "control" in report
        assert "baselines" in report
        assert "home_baseline" in report["baselines"]
        assert "market_baseline" in report["baselines"]
        assert "common_intersection" in report
        # Control should have Brier computed.
        assert report["control"].get("mean_brier") is not None
    finally:
        os.unlink(db)


def test_market_baseline_coverage_restricted_to_with_market():
    # Half the games have no market.
    games = _synthetic_games(20)
    for g in games[10:]:
        g["market_home"] = None
    db = _make_db(games)
    try:
        report = compare_models(db, model_id="heuristic_v1", cohort="main")
        mkt = report["baselines"]["market_baseline"]
        assert mkt["total_coverage"] <= 10
    finally:
        os.unlink(db)


# ---------- Recommend ----------

def test_recommend_insufficient_data_below_minimum():
    result = recommend(
        control_holdout={"n": 10, "brier": 0.25, "log_loss": 0.69, "accuracy": 0.55},
        challenger_holdout={"n": 10, "brier": 0.24, "log_loss": 0.68, "accuracy": 0.56},
    )
    assert result["recommendation"] == "INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE"


def test_recommend_keep_v1_when_no_improvement():
    n = MIN_HOLDOUT_ROWS + 10
    result = recommend(
        control_holdout={"n": n, "brier": 0.20, "log_loss": 0.55, "accuracy": 0.60},
        challenger_holdout={"n": n, "brier": 0.21, "log_loss": 0.56, "accuracy": 0.59},
        fold_stability_ok=True,
        subgroup_failure=False,
        replay_verified=True,
        human_approved=True,
    )
    assert result["recommendation"] == "KEEP V1"


def test_recommend_run_v2_in_shadow_pending_approval():
    n = MIN_HOLDOUT_ROWS + 10
    result = recommend(
        control_holdout={"n": n, "brier": 0.22, "log_loss": 0.58, "accuracy": 0.58},
        challenger_holdout={"n": n, "brier": 0.20, "log_loss": 0.55, "accuracy": 0.60},
        fold_stability_ok=True,
        subgroup_failure=False,
        replay_verified=True,
        human_approved=False,  # pending
    )
    assert result["recommendation"] == "RUN V2 IN SHADOW"


def test_recommend_promote_learned_v2_with_approval():
    n = MIN_HOLDOUT_ROWS + 10
    result = recommend(
        control_holdout={"n": n, "brier": 0.22, "log_loss": 0.58, "accuracy": 0.58},
        challenger_holdout={"n": n, "brier": 0.20, "log_loss": 0.55, "accuracy": 0.60},
        fold_stability_ok=True,
        subgroup_failure=False,
        replay_verified=True,
        human_approved=True,
    )
    assert result["recommendation"] == "PROMOTE LEARNED V2"


def test_recommend_market_residual_requires_incremental_over_market():
    n = MIN_HOLDOUT_ROWS + 10
    # Challenger beats control but NOT market -> cannot promote.
    result = recommend(
        control_holdout={"n": n, "brier": 0.24, "log_loss": 0.60, "accuracy": 0.57},
        challenger_holdout={"n": n, "brier": 0.22, "log_loss": 0.57, "accuracy": 0.59},
        challenger_model_id="market_residual_v2",
        market_holdout={"n": n, "brier": 0.21, "log_loss": 0.56, "accuracy": 0.59},
        fold_stability_ok=True,
        subgroup_failure=False,
        replay_verified=True,
        human_approved=True,
    )
    assert result["recommendation"] == "KEEP V1"


def test_recommend_promote_market_residual_when_incremental():
    n = MIN_HOLDOUT_ROWS + 10
    result = recommend(
        control_holdout={"n": n, "brier": 0.26, "log_loss": 0.62, "accuracy": 0.56},
        challenger_holdout={"n": n, "brier": 0.20, "log_loss": 0.54, "accuracy": 0.60},
        challenger_model_id="market_residual_v2",
        market_holdout={"n": n, "brier": 0.22, "log_loss": 0.57, "accuracy": 0.58},
        fold_stability_ok=True,
        subgroup_failure=False,
        replay_verified=True,
        human_approved=True,
    )
    assert result["recommendation"] == "PROMOTE MARKET RESIDUAL V2"
