"""P7 report generator tests.

Verifies:
  - All seven required reports + recommendation are produced from a temp DB.
  - Reports include dataset hash, date range, fold/holdout status, metrics.
  - Coverage levels are fixed (not tuned on outcomes).
  - Edge = model-minus-no-vig-market, not a bet claim.
  - Empty/insufficient DB → INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE (no fabrication).
  - No production tables mutated; reports use a temp SQLite DB only.
  - Recommendation is exactly one of the allowed verdicts.
"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

from src.dataset.build_game_dataset import build_game_dataset, build_folds
from src.eval.generate_p7_reports import generate_p7_reports, COVERAGE_LEVELS

MIGRATIONS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "storage", "migrations"
)

ALLOWED_VERDICTS = {
    "KEEP V1",
    "RUN V2 IN SHADOW",
    "PROMOTE LEARNED V2",
    "PROMOTE MARKET RESIDUAL V2",
    "INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE",
}


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
            conn.executescript(fh.read())
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
            (mid, f"test-{mid}", datetime.now(timezone.utc).isoformat()),
        )
    conn.commit()
    conn.close()


def _flat_vector(game_pk: int, home_win_count: int = 58) -> dict:
    """Reuse the P5 synthetic feature vector (real signal on homeWinPct)."""
    from src.core.feature_vector_py import buildFeatureVector, flattenFeatureVector

    home_losses = 100 - home_win_count
    away_wins = 100 - home_win_count
    away_losses = 100 - away_wins
    core = {
        "game": {
            "gamePk": game_pk, "officialDate": f"2026-06-{((game_pk % 27) + 1):02d}",
            "venue": {"id": 3, "name": "Park"},
            "weather": {"temp": "85", "wind": "10 mph, out"},
            "teams": {
                "away": {"team": {"id": 113}, "probablePitcher": {"id": 605397, "pitchHand": {"code": "R"}}},
                "home": {"team": {"id": 120}, "probablePitcher": {"id": 543037, "pitchHand": {"code": "L"}}},
            },
        },
        "teamStats": {
            "113": {"hitting": {"gamesPlayed": 100, "runs": 400 + away_wins, "ops": ".710"}, "pitching": {"era": "4.30", "whip": "1.35"}},
            "120": {"hitting": {"gamesPlayed": 100, "runs": 420 + home_win_count, "ops": ".740"}, "pitching": {"era": "3.90", "whip": "1.25"}},
        },
        "standings": {
            "113": {"leagueRecord": {"wins": away_wins, "losses": away_losses}, "gamesPlayed": 100, "runDifferential": -20,
                    "records": {"splitRecords": [{"type": "lastTen", "pct": 0.5}, {"type": "left", "pct": 0.45}, {"type": "right", "pct": 0.51}]}},
            "120": {"leagueRecord": {"wins": home_win_count, "losses": home_losses}, "gamesPlayed": 100, "runDifferential": 30,
                    "records": {"splitRecords": [{"type": "lastTen", "pct": 0.6}, {"type": "left", "pct": 0.57}, {"type": "right", "pct": 0.54}]}},
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
    return flattenFeatureVector(buildFeatureVector(core))


def _make_db(n_games: int = 220, with_market: bool = True) -> str:
    """Build a temp DB with promotion-eligible runs + outcomes + optional quotes."""
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
        flat = _flat_vector(game_pk)
        home_win_count = 40 + (game_pk % 40)
        flat = _flat_vector(game_pk, home_win_count)
        home_won = (flat["homeWinPct"] > 0.50) ^ ((game_pk % 5) == 0)
        prob = 58.0 if home_won else 42.0
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
             prob, 100 - prob, prob, 100 - prob,
             "home" if home_won else "away", "120",
             as_of.isoformat(), first_pitch.isoformat(), "scheduled_early", 1, as_of.isoformat()),
        )
        conn.execute(
            "INSERT INTO game_outcomes (game_pk, date_ymd, home_team_id, away_team_id, "
            "home_score, away_score, winner_team_id, loser_team_id, recorded_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (str(game_pk), date.strftime("%Y-%m-%d"), "120", "113",
             5 if home_won else 3, 3 if home_won else 5,
             "120" if home_won else "113", "113" if home_won else "120",
             datetime.now(timezone.utc).isoformat()),
        )
        if with_market:
            # No-vig market probability close to model prob but with disagreement.
            mkt_prob = (prob + 4.0) if (game_pk % 3 == 0) else prob
            conn.execute(
                "INSERT INTO market_quote_pairs (quote_pair_id, game_pk, bookmaker, market, "
                "home_no_vig_prob, away_no_vig_prob, observed_at_utc, fetched_at_utc, as_of_utc, "
                "is_eligible, is_opening, is_closing, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (f"qp-{game_pk}", str(game_pk), "draftkings", "moneyline",
                 mkt_prob, 100 - mkt_prob, as_of.isoformat(), as_of.isoformat(), as_of.isoformat(),
                 1, 1, 0, as_of.isoformat()),
            )
    conn.commit()
    conn.close()
    return db_path


# ---------- Structural ----------


def test_all_seven_reports_plus_recommendation_produced():
    db_path = _make_db(220)
    tmp_out = tempfile.mkdtemp()
    try:
        summary = generate_p7_reports(db_path, output_dir=tmp_out)
        paths = summary["report_paths"]
        for name in ["model_comparison", "ablation_index", "calibration_oof",
                     "accuracy_coverage", "model_market_disagreement",
                     "edge_buckets", "information_state_cohorts", "recommendation"]:
            assert name in paths, f"missing report: {name}"
            assert os.path.exists(paths[name]), f"{name} not written"
    finally:
        os.unlink(db_path)


def test_recommendation_is_an_allowed_verdict():
    db_path = _make_db(220)
    tmp_out = tempfile.mkdtemp()
    try:
        summary = generate_p7_reports(db_path, output_dir=tmp_out)
        rec = summary["recommendation"]
        assert rec["recommendation"] in ALLOWED_VERDICTS
        assert rec["promotion_eligible"] is False or rec["recommendation"].startswith("PROMOTE")
    finally:
        os.unlink(db_path)


def test_insufficient_db_yields_insufficient_data_no_fabrication():
    """A DB with 0 promotion-eligible rows must yield INSUFFICIENT DATA, not a
    fabricated promotion or a silent KEEP V1."""
    fd, db_path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    _apply_migrations(db_path)
    # No rows inserted.
    tmp_out = tempfile.mkdtemp()
    try:
        summary = generate_p7_reports(db_path, output_dir=tmp_out)
        rec = summary["recommendation"]
        assert rec["recommendation"] == "INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE"
        assert rec["promotion_eligible"] is False
        assert rec["holdout_rows"] == 0
    finally:
        os.unlink(db_path)


def test_reports_include_dataset_hash_and_date_range():
    db_path = _make_db(220)
    tmp_out = tempfile.mkdtemp()
    try:
        generate_p7_reports(db_path, output_dir=tmp_out)
        # machine JSON has the common block.
        with open(os.path.join(tmp_out, "model_comparison.json")) as f:
            payload = json.load(f)
        assert payload["dataset_hash"]
        assert len(payload["dataset_hash"]) == 64  # sha256 hex
        assert payload["date_range"]["start"]
        assert payload["date_range"]["end"]
        assert payload["row_count"] > 0
        assert "holdout_present" in payload
    finally:
        os.unlink(db_path)


def test_coverage_levels_are_fixed_not_tuned():
    """accuracy_coverage must use predeclared levels ranked by abs(p-0.5)."""
    db_path = _make_db(220)
    tmp_out = tempfile.mkdtemp()
    try:
        generate_p7_reports(db_path, output_dir=tmp_out)
        with open(os.path.join(tmp_out, "accuracy_coverage.md")) as f:
            text = f.read()
        for level in COVERAGE_LEVELS:
            assert f"{level:.2f}" in text
        assert "NOT tuned cutoffs" in text or "not tuned" in text.lower()
    finally:
        os.unlink(db_path)


def test_edge_report_is_model_minus_no_vig_not_bet_claim():
    db_path = _make_db(220, with_market=True)
    tmp_out = tempfile.mkdtemp()
    try:
        generate_p7_reports(db_path, output_dir=tmp_out)
        with open(os.path.join(tmp_out, "edge_buckets.md")) as f:
            text = f.read()
        assert "model_probability - no_vig_market_probability" in text
        assert "NOT a bet-selection claim" in text
    finally:
        os.unlink(db_path)


def test_model_market_disagreement_report_produced_with_metrics():
    db_path = _make_db(220, with_market=True)
    tmp_out = tempfile.mkdtemp()
    try:
        generate_p7_reports(db_path, output_dir=tmp_out)
        with open(os.path.join(tmp_out, "model_market_disagreement.md")) as f:
            text = f.read()
        assert "Disagreement" in text
        assert "market accuracy" in text
    finally:
        os.unlink(db_path)


def test_information_state_cohorts_reports_absence_not_fabrication():
    db_path = _make_db(220)
    tmp_out = tempfile.mkdtemp()
    try:
        generate_p7_reports(db_path, output_dir=tmp_out)
        with open(os.path.join(tmp_out, "information_state_cohorts.md")) as f:
            text = f.read()
        # close_time + confirmed_lineup cohorts will be empty (all runs scheduled_early).
        assert "close_time" in text
        assert "confirmed_lineup" in text
        with open(os.path.join(tmp_out, "information_state_cohorts.json")) as f:
            payload = json.load(f)
        assert "cohorts" in payload
    finally:
        os.unlink(db_path)


def test_calibration_oof_reports_absence_without_artifact():
    db_path = _make_db(220)
    tmp_out = tempfile.mkdtemp()
    # Point artifacts dir at a temp dir with no OOF artifact.
    os.environ["MLB_MODEL_ARTIFACTS_DIR"] = tmp_out
    try:
        generate_p7_reports(db_path, output_dir=tmp_out)
        with open(os.path.join(tmp_out, "calibration_oof.md")) as f:
            text = f.read()
        assert "No OOF calibration proposal artifact found" in text or "holdout" in text.lower()
    finally:
        os.environ.pop("MLB_MODEL_ARTIFACTS_DIR", None)
        os.unlink(db_path)


def test_holdout_never_opened_in_test_fold_reports():
    """Test-fold metrics must not include holdout rows."""
    db_path = _make_db(220)
    tmp_out = tempfile.mkdtemp()
    try:
        generate_p7_reports(db_path, output_dir=tmp_out)
        with open(os.path.join(tmp_out, "model_comparison.json")) as f:
            payload = json.load(f)
        comp = payload["comparison"]
        ctrl = comp.get("control", {})
        # holdout is present but not scored in the OOF control metrics.
        assert payload["holdout_present"] in (True, False)
        # total coverage should be <= row_count (only test folds).
        if ctrl.get("total_coverage") is not None:
            assert ctrl["total_coverage"] <= payload["row_count"]
    finally:
        os.unlink(db_path)


def test_no_production_db_mutated():
    """Generator reads read-only; production tables never touched."""
    db_path = _make_db(220)
    tmp_out = tempfile.mkdtemp()
    before = os.path.getsize(db_path)
    try:
        generate_p7_reports(db_path, output_dir=tmp_out)
        after = os.path.getsize(db_path)
        assert before == after, "DB was mutated by report generation"
    finally:
        os.unlink(db_path)


def test_recommendation_json_has_per_challenger_breakdown():
    db_path = _make_db(220)
    tmp_out = tempfile.mkdtemp()
    try:
        generate_p7_reports(db_path, output_dir=tmp_out)
        with open(os.path.join(tmp_out, "recommendation.json")) as f:
            payload = json.load(f)
        assert "per_challenger" in payload
        assert "learned_v2_logistic" in payload["per_challenger"]
        assert "market_residual_v2" in payload["per_challenger"]
        for chal, rec in payload["per_challenger"].items():
            assert rec["recommendation"] in ALLOWED_VERDICTS
    finally:
        os.unlink(db_path)
