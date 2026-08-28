"""Tests for the Prediction Audit Card backend (src/prediction_audit.py).

Fixtures build a real sqlite file using the actual migration SQL
(002 + 006 subsets used by the audit reader) so the reader is tested against
the production schema, not a hand-invented one.
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from src.prediction_audit import (
    build_heuristic_contributions,
    get_prediction_audit,
    list_audit_predictions,
)

_MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "src" / "storage" / "migrations"


def _apply_real_migrations(conn: sqlite3.Connection) -> None:
    """Apply the real 002 + 006 migration SQL (006 needs 002's tables)."""
    for name in ("002_immutable_accounting.sql", "006_model_prediction_history.sql"):
        conn.executescript((_MIGRATIONS_DIR / name).read_text(encoding="utf-8"))
    # Minimal legacy tables the audit reader may join against.
    conn.executescript(
        """
        CREATE TABLE picks (
          prediction_run_id TEXT, game_pk TEXT, run_id TEXT, date_ymd TEXT,
          matchup TEXT, saved_at TEXT, payload TEXT
        );
        CREATE TABLE bet_ledger (
          decision_id TEXT, game_pk TEXT, run_id TEXT, market TEXT, team TEXT,
          side TEXT, odds REAL, edge REAL, units_staked REAL, status TEXT,
          result TEXT, units_pl REAL, clv REAL, recommended_at TEXT, settled_at TEXT
        );
        """
    )


_BREAKDOWN = {
    "rawEdge": 0.31,
    "dampenedEdge": 0.31 * 0.5,
    "dampeningFactor": 0.5,
    "recordDominated": False,
    "offenseEdge": 0.10,
    "preventionEdge": 0.05,
    "starterEdge": 0.12,
    "lineupEdge": 0.01,
    "bullpenEdge": -0.02,
    "fatigueEdge": 0.0,
    "log5Edge": 0.02,
    "formEdge": 0.01,
    "h2hEdge": 0.0,
    "memoryEdge": 0.0,
    "platoonEdge": 0.0,
    "homeFieldEdge": 0.02,
    "weatherEdge": 0.0,
    "confirmationEdge": 0.0,
}


def _seed(conn: sqlite3.Connection) -> None:
    now = "2026-08-20T12:00:00.000Z"
    as_of = "2026-08-20T12:00:00.000Z"
    first_pitch = "2026-08-20T23:00:00Z"

    conn.execute(
        """INSERT INTO prediction_runs (
             run_id, game_pk, market, date_ymd, as_of_utc, first_pitch_utc,
             model_version, payload, created_at
           ) VALUES (?, ?, 'moneyline', ?, ?, ?, ?, ?, ?)""",
        (
            "run-1", "900001", "2026-08-20", as_of, first_pitch,
            "moneyline-core-v1.0",
            json.dumps({"snapshotPath": "/nonexistent/snap.json"}),
            now,
        ),
    )

    payload = {
        "modelBreakdown": _BREAKDOWN,
        "featureAvailability": {"standings": True, "probableStarters": False},
        "featureFallbacks": {"features": ["probable_starter_season"]},
    }
    conn.execute(
        """INSERT INTO model_predictions (
             prediction_id, run_id, game_pk, date_ymd, model_id,
             model_impl_version, feature_schema_version,
             raw_home_probability, raw_away_probability,
             calibrated_home_probability, calibrated_away_probability,
             pick_side, pick_team_id, pick_probability, status,
             paired_quote_pair_id, as_of_utc, first_pitch_utc,
             information_state, promotion_eligible,
             model_version, calibration_version, snapshot_hash, payload, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            "mp-run-1-heuristic_v1", "run-1", "900001", "2026-08-20",
            "heuristic_v1", "moneyline-core-v1.0", "mlb-control-features-v1.0",
            55.0, 45.0, 53.0, 47.0, "home", "137", 53.0, "NO BET",
            "qp-pre", as_of, first_pitch, "projected_lineup", 1,
            "moneyline-core-v1.0", "cal-moneyline-test", "hash-1",
            json.dumps(payload), now,
        ),
    )

    # Quote BEFORE as_of (eligible at prediction time), paired.
    conn.execute(
        """INSERT INTO market_quote_pairs (
             quote_pair_id, game_pk, bookmaker, market, home_odds, away_odds,
             home_no_vig_prob, away_no_vig_prob, fetched_at_utc, first_pitch_utc,
             is_opening, is_closing, is_eligible, created_at
           ) VALUES (?, ?, ?, 'moneyline', ?, ?, ?, ?, ?, ?, 1, 0, 1, ?)""",
        ("qp-pre", "900001", "fanduel", -120.0, 110.0, 0.53, 0.47,
         "2026-08-20T11:30:00.000Z", first_pitch, now),
    )
    # Quote AFTER as_of, marked closing — must never appear as "at prediction".
    conn.execute(
        """INSERT INTO market_quote_pairs (
             quote_pair_id, game_pk, bookmaker, market, home_odds, away_odds,
             home_no_vig_prob, away_no_vig_prob, fetched_at_utc, first_pitch_utc,
             is_opening, is_closing, is_eligible, created_at
           ) VALUES (?, ?, ?, 'moneyline', ?, ?, ?, ?, ?, ?, 0, 1, 1, ?)""",
        ("qp-close", "900001", "draftkings", -140.0, 130.0, 0.57, 0.43,
         "2026-08-20T22:55:00.000Z", first_pitch, now),
    )

    conn.execute(
        """INSERT INTO picks (
             prediction_run_id, game_pk, run_id, date_ymd, matchup, saved_at, payload
           ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            "uuid-1", "900001", "run-1", "2026-08-20", "AZ @ SF", now,
            json.dumps(
                {
                    "home": {"id": 137, "name": "San Francisco Giants", "abbreviation": "SF"},
                    "away": {"id": 109, "name": "Arizona Diamondbacks", "abbreviation": "AZ"},
                    "betDecision": {
                        "status": "NO BET",
                        "reasons": ["edge below threshold"],
                        "edge": 1.2,
                        "odds": -120,
                        "book": "FanDuel",
                        "teamName": "San Francisco Giants",
                    },
                    "predictionQuality": {
                        "status": "DEGRADED",
                        "reasons": ["missing_probable_starter_identity"],
                    },
                }
            ),
        ),
    )

    conn.execute(
        """INSERT INTO game_outcomes (
             game_pk, date_ymd, home_team_id, away_team_id, home_score, away_score,
             winner_team_id, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ("900001", "2026-08-20", "137", "109", 5, 3, "137", now),
    )
    conn.commit()


class PredictionAuditBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmp.name) / "state.sqlite"
        conn = sqlite3.connect(str(self.db_path))
        _apply_real_migrations(conn)
        _seed(conn)
        conn.close()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_list_returns_seeded_prediction(self) -> None:
        listing = list_audit_predictions(db_path=self.db_path)
        self.assertEqual(len(listing["rows"]), 1)
        row = listing["rows"][0]
        self.assertEqual(row["prediction_id"], "mp-run-1-heuristic_v1")
        self.assertEqual(row["model_id"], "heuristic_v1")
        self.assertEqual(row["matchup"], "AZ @ SF")
        self.assertTrue(row["has_result"])

    def test_list_date_filter(self) -> None:
        self.assertEqual(
            list_audit_predictions(date_ymd="2026-01-01", db_path=self.db_path)["rows"], []
        )
        self.assertEqual(
            len(list_audit_predictions(date_ymd="2026-08-20", db_path=self.db_path)["rows"]), 1
        )

    def test_audit_unknown_prediction_returns_none(self) -> None:
        self.assertIsNone(get_prediction_audit("mp-missing", db_path=self.db_path))

    def test_audit_probability_stages_are_distinct_fields(self) -> None:
        audit = get_prediction_audit("mp-run-1-heuristic_v1", db_path=self.db_path)
        probs = audit["probabilities"]
        self.assertEqual(probs["raw_home"], 55.0)
        self.assertEqual(probs["calibrated_home"], 53.0)
        # Never blended into one number: raw and calibrated stay separate.
        self.assertNotEqual(probs["raw_home"], probs["calibrated_home"])

    def test_market_at_prediction_respects_as_of(self) -> None:
        audit = get_prediction_audit("mp-run-1-heuristic_v1", db_path=self.db_path)
        at_pred = audit["market"]["at_prediction"]
        self.assertEqual(at_pred["quote_pair_id"], "qp-pre")
        self.assertEqual(audit["market"]["source"], "paired")
        # The post-as_of closing quote is reported only under "closing".
        self.assertEqual(audit["market"]["closing"]["quote_pair_id"], "qp-close")

    def test_paired_quote_after_as_of_is_rejected(self) -> None:
        conn = sqlite3.connect(str(self.db_path))
        conn.execute(
            "UPDATE model_predictions SET paired_quote_pair_id = 'qp-close' "
            "WHERE prediction_id = 'mp-run-1-heuristic_v1'"
        )
        conn.commit()
        conn.close()
        audit = get_prediction_audit("mp-run-1-heuristic_v1", db_path=self.db_path)
        # Falls back to the nearest pre-as_of quote instead of leaking the
        # post-prediction closing quote into "at prediction" context.
        self.assertEqual(audit["market"]["at_prediction"]["quote_pair_id"], "qp-pre")
        self.assertEqual(audit["market"]["source"], "nearest_pre_as_of")

    def test_decision_reasons_and_bet_flag(self) -> None:
        audit = get_prediction_audit("mp-run-1-heuristic_v1", db_path=self.db_path)
        decision = audit["decision"]
        self.assertFalse(decision["is_bet"])
        self.assertEqual(decision["status"], "NO BET")
        self.assertEqual(decision["reasons"], ["edge below threshold"])
        self.assertEqual(decision["edge"], 1.2)

    def test_result_and_correctness(self) -> None:
        audit = get_prediction_audit("mp-run-1-heuristic_v1", db_path=self.db_path)
        result = audit["result"]
        self.assertTrue(result["recorded"])
        self.assertEqual(result["winner_side"], "home")
        self.assertTrue(result["prediction_correct"])

    def test_data_quality_marks_fallback_and_missing_explicitly(self) -> None:
        audit = get_prediction_audit("mp-run-1-heuristic_v1", db_path=self.db_path)
        quality = audit["dataQuality"]
        self.assertTrue(quality["recorded"])
        self.assertEqual(quality["status"], "DEGRADED")
        states = {item["input"]: item["state"] for item in quality["inputs"]}
        self.assertEqual(states["standings"], "available")
        # Missing + fallback are explicit states, never silently "available".
        self.assertEqual(states["probableStarters"], "fallback")

    def test_missing_snapshot_file_is_reported_not_faked(self) -> None:
        audit = get_prediction_audit("mp-run-1-heuristic_v1", db_path=self.db_path)
        self.assertEqual(audit["replay"]["snapshot_path"], "/nonexistent/snap.json")
        self.assertFalse(audit["replay"]["snapshot_available"])

    def test_missing_db_returns_warning_not_fake_rows(self) -> None:
        missing = Path(self._tmp.name) / "nope.sqlite"
        listing = list_audit_predictions(db_path=missing)
        self.assertEqual(listing["rows"], [])
        self.assertIn("warning", listing)
        self.assertIsNone(get_prediction_audit("mp-run-1-heuristic_v1", db_path=missing))


class HeuristicContributionTests(unittest.TestCase):
    def test_components_sum_to_raw_edge(self) -> None:
        result = build_heuristic_contributions(_BREAKDOWN)
        self.assertTrue(result["available"])
        self.assertTrue(result["decomposition_complete"])
        total = sum(item["edge_contribution"] for item in result["contributions"])
        self.assertAlmostEqual(total, _BREAKDOWN["rawEdge"], places=9)

    def test_record_dominated_applies_045_to_record_context_only(self) -> None:
        breakdown = dict(_BREAKDOWN)
        breakdown["recordDominated"] = True
        # rawEdge with the 0.45 multiplier on log5/form/h2h/memory/platoon:
        matchup = 0.10 + 0.05 + 0.12 + 0.01 - 0.02 + 0.0 + 0.02 + 0.0 + 0.0
        record = (0.02 + 0.01 + 0.0 + 0.0 + 0.0) * 0.45
        breakdown["rawEdge"] = matchup + record
        result = build_heuristic_contributions(breakdown)
        self.assertTrue(result["decomposition_complete"])
        by_feature = {item["feature"]: item for item in result["contributions"]}
        self.assertAlmostEqual(by_feature["season_record_log5"]["edge_contribution"], 0.02 * 0.45)
        self.assertAlmostEqual(by_feature["offense"]["edge_contribution"], 0.10)

    def test_missing_breakdown_yields_unavailable_not_fake(self) -> None:
        for value in (None, {}, {"note": "no components"}):
            result = build_heuristic_contributions(value)
            self.assertFalse(result["available"])
            self.assertEqual(result["contributions"], [])

    def test_incomplete_decomposition_is_flagged(self) -> None:
        breakdown = dict(_BREAKDOWN)
        breakdown["rawEdge"] = 999.0  # inconsistent with components
        result = build_heuristic_contributions(breakdown)
        self.assertTrue(result["available"])
        self.assertFalse(result["decomposition_complete"])


class PredictionAuditApiTests(unittest.TestCase):
    """The API endpoints delegate to the audit module and 404 on unknown ids."""

    @classmethod
    def setUpClass(cls) -> None:
        import os

        os.environ.setdefault("NODE_ENV", "test")
        os.environ.setdefault("DASHBOARD_API_TOKEN", "")
        import src.dashboard_api as dashboard_api

        cls.dashboard_api = dashboard_api

    def test_unknown_prediction_returns_404(self) -> None:
        from fastapi import HTTPException
        from unittest.mock import patch

        with patch.object(self.dashboard_api, "get_prediction_audit", return_value=None):
            with self.assertRaises(HTTPException) as ctx:
                self.dashboard_api.api_prediction_audit("mp-unknown")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_audit_endpoint_returns_payload(self) -> None:
        from unittest.mock import patch

        payload = {"prediction": {"prediction_id": "mp-x"}}
        with patch.object(self.dashboard_api, "get_prediction_audit", return_value=payload):
            self.assertEqual(self.dashboard_api.api_prediction_audit("mp-x"), payload)

    def test_list_endpoint_delegates(self) -> None:
        from unittest.mock import patch

        listing = {"rows": []}
        with patch.object(
            self.dashboard_api, "list_audit_predictions", return_value=listing
        ) as mocked:
            self.assertEqual(
                self.dashboard_api.api_audit_predictions(date="2026-08-20", limit=10), listing
            )
        mocked.assert_called_once_with(date_ymd="2026-08-20", limit=10)


if __name__ == "__main__":
    unittest.main()
