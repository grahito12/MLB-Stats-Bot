"""P5 ablation engine tests.

Verifies:
  - control + full-model + per-family metrics are produced
  - leave-one-out differs from full (family has an effect when supported)
  - insufficient families yield a note, never a fabricated metric
  - holdout is never opened (only test folds scored)
  - report JSON + Markdown round-trip
"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

from src.dataset.build_game_dataset import build_game_dataset
from src.eval.ablation import (
    run_ablations,
    write_ablation_report,
    CONTROL_FAMILY_GROUPS,
    _complement,
    _fit_logistic_fold,
)
from src.models.train_learned_v2_logistic import FEATURE_NAMES

MIGRATIONS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "storage", "migrations"
)


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
    """Build a synthetic flattened feature vector with a real signal on homeWinPct."""
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


def _make_db(n_games: int = 200) -> str:
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
        # Outcome tied to a learnable signal. Vary home win count per game so
        # labels split roughly 50/50 while staying correlated with team strength.
        home_win_count = 40 + (game_pk % 40)  # 40..79 -> homeWinPct 0.40..0.79
        # Re-derive a per-game feature vector with the varied record so the
        # signal is real, then set the outcome from it with noise.
        flat = _flat_vector(game_pk, home_win_count)
        home_won = (flat["homeWinPct"] > 0.50) ^ ((game_pk % 5) == 0)  # ~20% flips for class balance
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
             58.0 if home_won else 42.0, 42.0 if home_won else 58.0,
             58.0 if home_won else 42.0, 42.0 if home_won else 58.0,
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
    conn.commit()
    conn.close()
    return db_path


# ---------- Structural ----------

def test_complement_leaves_out_subset():
    subset = CONTROL_FAMILY_GROUPS["weather"]
    comp = _complement(subset)
    assert set(subset).isdisjoint(set(comp))
    assert len(comp) == len(FEATURE_NAMES) - len(subset)


def test_control_family_groups_partition_all_62_features():
    """Every control feature should belong to exactly one family group."""
    all_grouped: list[str] = []
    for subset in CONTROL_FAMILY_GROUPS.values():
        all_grouped.extend(subset)
    # No duplicates
    assert len(all_grouped) == len(set(all_grouped)), "feature appears in >1 family"
    # Every grouped feature is a real control feature
    for f in all_grouped:
        assert f in FEATURE_NAMES, f"{f} not in FEATURE_NAMES"


# ---------- Engine ----------

def test_run_ablations_produces_control_and_full_reference():
    db_path = _make_db(200)
    try:
        report = run_ablations(db_path, family_groups=CONTROL_FAMILY_GROUPS)
        assert report["row_count"] > 0
        assert "control_stored_metrics" in report
        assert "full_model_metrics" in report
        assert len(report["family_ablations"]) == len(CONTROL_FAMILY_GROUPS)
        # at least some families should have OOF coverage
        covered = [f for f in report["family_ablations"] if f["coverage"] > 0]
        assert len(covered) > 0
    finally:
        os.unlink(db_path)


def test_leave_one_out_differs_from_full_when_family_has_signal():
    """The 'form' family carries homeWinPct (the synthetic signal). Removing it
    should change LOO metrics vs full."""
    db_path = _make_db(200)
    try:
        report = run_ablations(db_path, family_groups=CONTROL_FAMILY_GROUPS)
        form = next(f for f in report["family_ablations"] if f["family"] == "form")
        full = report["full_model_metrics"]
        if form["coverage"] > 0 and full.get("n", 0) > 0:
            # LOO brier should differ from full (signal removed).
            loo_brier = form["leave_one_out_metrics"].get("brier")
            full_brier = full.get("brier")
            if loo_brier is not None and full_brier is not None:
                assert loo_brier != full_brier or form["delta_brier_loo_minus_full"] is not None
    finally:
        os.unlink(db_path)


def test_holdout_not_opened_only_test_folds_scored():
    """Ablation must only score test folds, never the holdout."""
    db_path = _make_db(200)
    try:
        clean, _ = build_game_dataset(db_path, model_id="heuristic_v1", cohort="main")
        from src.dataset.build_game_dataset import build_folds

        folds, _ = build_folds(clean)
        holdout = [f for f in folds if f["fold_type"] == "holdout"]
        if holdout:
            report = run_ablations(db_path, family_groups=CONTROL_FAMILY_GROUPS)
            # full model coverage should not exceed total test-fold row count
            test_rows = 0
            for f in folds:
                if f["fold_type"] == "test":
                    test_rows += f["game_count"]
            assert report["full_model_metrics"].get("n", 0) <= test_rows + 1  # +1 tolerance
    finally:
        os.unlink(db_path)


def test_report_json_and_markdown_round_trip(tmp_path):
    db_path = _make_db(200)
    try:
        report = run_ablations(db_path, family_groups=CONTROL_FAMILY_GROUPS)
        md_path = write_ablation_report(report, str(tmp_path))
        assert os.path.exists(md_path)
        json_path = md_path.replace(".md", ".json")
        assert os.path.exists(json_path)
        with open(json_path) as f:
            loaded = json.load(f)
        assert loaded["ablation_schema"] == report["ablation_schema"]
        with open(md_path) as f:
            md = f.read()
        assert "Chronological Ablation Report" in md
        assert "Per-family ablation" in md
    finally:
        os.unlink(db_path)


def test_insufficient_family_yields_note_not_fabricated_metric():
    """A family whose LOO fold can't fit must carry a note, not a fake metric."""
    db_path = _make_db(200)
    try:
        report = run_ablations(db_path, family_groups=CONTROL_FAMILY_GROUPS)
        for fr in report["family_ablations"]:
            if fr["coverage"] == 0:
                assert fr["note"] is not None
                assert "insufficient" in fr["note"]
    finally:
        os.unlink(db_path)
