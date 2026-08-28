"""P0 prediction-lifecycle hardening regression tests.

Covers the five hardening issues:
  2. metric row alignment (src/eval/metrics.py)
  3. evaluation dataset eligibility leakage (src/dataset/build_game_dataset.py)
  4. fail-closed promotion governance (src/eval/recommend.py)
  5. market temporal provenance (src/prediction_audit.py)
(Issue 1, CI installation, is covered by lockfile regeneration + CI itself.)
"""

from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

import pytest

_MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "src" / "storage" / "migrations"


def _apply_real_migrations(conn: sqlite3.Connection) -> None:
    """Apply the real 002 + 006 migration SQL so readers see production schema."""
    for name in ("002_immutable_accounting.sql", "006_model_prediction_history.sql"):
        conn.executescript((_MIGRATIONS_DIR / name).read_text(encoding="utf-8"))

from src.dataset.build_game_dataset import (
    build_game_dataset,
    select_main_cohort_row,
)
from src.eval.metrics import (
    _to_arrays,
    accuracy,
    brier_score,
    ece,
    log_loss,
    model_metrics,
    reliability_bins,
    roc_auc,
)
from src.eval.recommend import MIN_HOLDOUT_ROWS, recommend


# ---------------------------------------------------------------------------
# Issue 2: metric row alignment
# ---------------------------------------------------------------------------


class TestMetricRowAlignment(unittest.TestCase):
    def test_case_a_none_in_probs_does_not_shift_rows(self) -> None:
        # probs [0.60, None, 0.40] + outcomes [1, 0, 1] must pair as
        # (0.60, 1) and (0.40, 1) — never (0.60, 1), (0.40, 0).
        p, y = _to_arrays([0.60, None, 0.40], [1, 0, 1])
        self.assertEqual(list(p), [0.60, 0.40])
        self.assertEqual(list(y), [1, 1])
        # Brier under correct pairing: mean((0.6-1)^2, (0.4-1)^2) = 0.26.
        # Under the misaligned pairing it would be mean(0.16, 0.16) = 0.16.
        self.assertAlmostEqual(brier_score([0.60, None, 0.40], [1, 0, 1]), 0.26)

    def test_case_b_leading_none(self) -> None:
        p, y = _to_arrays([None, 0.70], [0, 1])
        self.assertEqual(list(p), [0.70])
        self.assertEqual(list(y), [1])
        self.assertEqual(accuracy([None, 0.70], [0, 1]), 1.0)

    def test_case_c_length_mismatch_raises(self) -> None:
        with pytest.raises(ValueError):
            _to_arrays([0.5, 0.6], [1])
        with pytest.raises(ValueError):
            brier_score([0.5], [1, 0])
        with pytest.raises(ValueError):
            model_metrics([0.5, 0.6, 0.7], [1, 0])

    def test_none_outcome_drops_the_pair(self) -> None:
        p, y = _to_arrays([0.55, 0.65], [None, 1])
        self.assertEqual(list(p), [0.65])
        self.assertEqual(list(y), [1])

    def test_all_metrics_share_paired_semantics(self) -> None:
        probs = [0.9, None, 0.1, 0.8, None]
        outs = [1, 1, 0, None, 0]
        # Surviving pairs: (0.9,1), (0.1,0).
        self.assertEqual(accuracy(probs, outs), 1.0)
        self.assertAlmostEqual(brier_score(probs, outs), ((0.9 - 1) ** 2 + 0.1**2) / 2)
        self.assertIsNotNone(log_loss(probs, outs))
        self.assertEqual(roc_auc(probs, outs), 1.0)
        self.assertIsNotNone(ece(probs, outs))
        bins = reliability_bins(probs, outs)
        self.assertEqual(sum(b["count"] for b in bins), 2)
        m = model_metrics(probs, outs)
        self.assertEqual(m["n"], 2)

    def test_all_none_returns_empty_not_error(self) -> None:
        m = model_metrics([None, None], [1, 0])
        self.assertEqual(m["n"], 0)
        self.assertIsNone(m["brier"])


# ---------------------------------------------------------------------------
# Issue 3: evaluation dataset eligibility leakage
# ---------------------------------------------------------------------------


# Reuse the P1 suite's real-migration fixture builders so these tests run
# against the production schema, not a hand-invented one.
from tests.test_p1_game_dataset import _make_db, _synthetic_games


def _game(i: int, **kw) -> dict:
    base = _synthetic_games(i + 1)[i]
    base.update(kw)
    return base


class TestDatasetEligibilityInvariant(unittest.TestCase):
    def test_eligible_row_enters_clean(self) -> None:
        db = _make_db([_game(0)])
        try:
            clean, quarantined = build_game_dataset(db, model_id="heuristic_v1")
            self.assertEqual(len(clean), 1)
            self.assertEqual(len(quarantined), 0)
            self.assertTrue(clean[0].promotion_eligible)
        finally:
            os.unlink(db)

    def test_ineligible_fallback_row_is_quarantined_not_clean(self) -> None:
        # The exact leak path from the spec: no promotion-eligible run exists,
        # the fallback row is temporally valid AND has an outcome — it must be
        # quarantined as not_promotion_eligible, never clean.
        db = _make_db([_game(0, promotion_eligible=False)])
        try:
            clean, quarantined = build_game_dataset(db, model_id="heuristic_v1")
            self.assertEqual(len(clean), 0)
            self.assertEqual(len(quarantined), 1)
            self.assertEqual(quarantined[0].quarantine_reason, "not_promotion_eligible")
            # Still auditable — the row is retained, not discarded.
            self.assertFalse(quarantined[0].promotion_eligible)
        finally:
            os.unlink(db)

    def test_missing_outcome_not_clean(self) -> None:
        db = _make_db([_game(0)])
        try:
            conn = sqlite3.connect(db)
            conn.execute("DELETE FROM game_outcomes")
            conn.commit()
            conn.close()
            clean, quarantined = build_game_dataset(db, model_id="heuristic_v1")
            self.assertEqual(len(clean), 0)
            self.assertEqual(quarantined[0].quarantine_reason, "missing_outcome")
        finally:
            os.unlink(db)

    def test_temporally_invalid_row_not_clean(self) -> None:
        # as_of AFTER first pitch (negative offset in the fixture builder).
        db = _make_db([_game(0, as_of_offset_hours=-1)])
        try:
            clean, quarantined = build_game_dataset(db, model_id="heuristic_v1")
            self.assertEqual(len(clean), 0)
            self.assertEqual(quarantined[0].quarantine_reason, "post_pitch_as_of")
        finally:
            os.unlink(db)

    def test_multiple_runs_deterministic_cohort_selection(self) -> None:
        # Two eligible runs for the same game: earliest as_of wins,
        # regardless of insertion order.
        db = _make_db([_game(0)])
        try:
            conn = sqlite3.connect(db)
            game_pk = str(_game(0)["game_pk"])
            row = conn.execute(
                "SELECT as_of_utc, first_pitch_utc, date_ymd FROM prediction_runs LIMIT 1"
            ).fetchone()
            base_as_of, first_pitch, date = row
            # A LATER (still pregame) eligible run for the same game, inserted
            # after the original: must not displace the earliest-as_of run.
            later_as_of = base_as_of.replace("T", "T").replace(":00:00", ":45:00", 1)
            conn.execute(
                "INSERT INTO prediction_runs (run_id, game_pk, market, date_ymd, "
                "prediction_timestamp_utc, as_of_utc, first_pitch_utc, created_at, "
                "model_id, information_state, producer_timestamp_utc) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                ("run-late", game_pk, "moneyline", date, later_as_of, later_as_of,
                 first_pitch, later_as_of, "heuristic_v1", "scheduled_early", later_as_of),
            )
            conn.execute(
                "INSERT INTO model_predictions (prediction_id, run_id, game_pk, date_ymd, "
                "model_id, raw_home_probability, raw_away_probability, "
                "calibrated_home_probability, calibrated_away_probability, pick_side, "
                "as_of_utc, first_pitch_utc, information_state, promotion_eligible, "
                "created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("mp-run-late", "run-late", game_pk, date, "heuristic_v1",
                 60, 40, 58, 42, "home", later_as_of, first_pitch,
                 "scheduled_early", 1, later_as_of),
            )
            conn.commit()
            conn.close()

            clean, _ = build_game_dataset(db, model_id="heuristic_v1")
            self.assertEqual(len(clean), 1)
            self.assertEqual(clean[0].as_of_utc, base_as_of)
            self.assertNotEqual(clean[0].run_id, "run-late")
        finally:
            os.unlink(db)

    def test_select_main_cohort_marks_ineligible_fallback(self) -> None:
        run = {
            "run_id": "r1", "game_pk": "1", "date_ymd": "2026-07-01",
            "as_of_utc": "2026-07-01T12:00:00+00:00",
            "first_pitch_utc": "2026-07-01T23:00:00+00:00",
            "promotion_eligible": 0, "model_id": "heuristic_v1",
        }
        outcome = {
            "game_pk": "1", "home_team_id": "137", "away_team_id": "109",
            "home_score": 5, "away_score": 3, "winner_team_id": "137",
        }
        row, reason = select_main_cohort_row([run], {"1": outcome}, {})
        self.assertIsNotNone(row)
        self.assertEqual(reason, "not_promotion_eligible")


# ---------------------------------------------------------------------------
# Issue 4: fail-closed promotion governance
# ---------------------------------------------------------------------------

_N = MIN_HOLDOUT_ROWS + 10
_GOOD_CONTROL = {"n": _N, "brier": 0.22, "log_loss": 0.58, "accuracy": 0.58}
_GOOD_CHALLENGER = {"n": _N, "brier": 0.20, "log_loss": 0.55, "accuracy": 0.60}
_ALL_PASS = dict(fold_stability_ok=True, subgroup_failure=False, replay_verified=True)


class TestFailClosedPromotion(unittest.TestCase):
    def _assert_not_promotable(self, result: dict, expected_reason: str) -> None:
        self.assertFalse(result["promotion_eligible"])
        self.assertFalse(result["recommendation"].startswith("PROMOTE"))
        self.assertIn(expected_reason, result["reasons"])

    def test_replay_unknown_blocks_promotion(self) -> None:
        result = recommend(
            _GOOD_CONTROL, _GOOD_CHALLENGER, human_approved=True,
            **{**_ALL_PASS, "replay_verified": None},
        )
        self._assert_not_promotable(result, "replay_verification_unknown")
        # Healthy metrics + unknown evidence -> shadow, never PROMOTE.
        self.assertEqual(result["recommendation"], "RUN V2 IN SHADOW")

    def test_fold_stability_unknown_blocks_promotion(self) -> None:
        result = recommend(
            _GOOD_CONTROL, _GOOD_CHALLENGER, human_approved=True,
            **{**_ALL_PASS, "fold_stability_ok": None},
        )
        self._assert_not_promotable(result, "fold_stability_unknown")

    def test_subgroup_unknown_blocks_promotion(self) -> None:
        result = recommend(
            _GOOD_CONTROL, _GOOD_CHALLENGER, human_approved=True,
            **{**_ALL_PASS, "subgroup_failure": None},
        )
        self._assert_not_promotable(result, "subgroup_result_unknown")

    def test_market_comparison_unknown_blocks_market_challenger(self) -> None:
        # market_residual_v2 with NO market holdout at all.
        result = recommend(
            _GOOD_CONTROL, _GOOD_CHALLENGER,
            challenger_model_id="market_residual_v2",
            market_holdout=None, human_approved=True, **_ALL_PASS,
        )
        self._assert_not_promotable(result, "market_comparison_evidence_missing")

    def test_market_comparison_missing_brier_blocks_market_challenger(self) -> None:
        result = recommend(
            _GOOD_CONTROL, _GOOD_CHALLENGER,
            challenger_model_id="market_residual_v2",
            market_holdout={"n": _N, "brier": None}, human_approved=True, **_ALL_PASS,
        )
        self._assert_not_promotable(result, "market_comparison_evidence_missing")

    def test_missing_challenger_holdout_blocks_promotion(self) -> None:
        result = recommend(_GOOD_CONTROL, None, human_approved=True, **_ALL_PASS)
        self.assertEqual(
            result["recommendation"], "INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE"
        )

    def test_explicit_fail_still_blocks(self) -> None:
        for kw, reason in [
            ({"replay_verified": False}, "replay_not_verified"),
            ({"fold_stability_ok": False}, "fold_instability"),
            ({"subgroup_failure": True}, "severe_subgroup_failure"),
        ]:
            result = recommend(
                _GOOD_CONTROL, _GOOD_CHALLENGER, human_approved=True,
                **{**_ALL_PASS, **kw},
            )
            self._assert_not_promotable(result, reason)
            self.assertEqual(result["recommendation"], "KEEP V1")

    def test_all_pass_promotes_with_approval(self) -> None:
        # Sanity: the fail-closed change must not block genuinely complete
        # PASS evidence.
        result = recommend(
            _GOOD_CONTROL, _GOOD_CHALLENGER, human_approved=True, **_ALL_PASS
        )
        self.assertEqual(result["recommendation"], "PROMOTE LEARNED V2")

    def test_production_recommendation_stays_non_promoted(self) -> None:
        # The live P7 report calls recommend with challenger_holdout=None and
        # replay/fold/subgroup unknown — must remain non-promoted.
        result = recommend(
            control_holdout={"n": _N, "brier": 0.24, "log_loss": 0.6, "accuracy": 0.55},
            challenger_holdout=None,
            fold_stability_ok=None, subgroup_failure=None, replay_verified=False,
            human_approved=False,
        )
        self.assertFalse(result["promotion_eligible"])


# ---------------------------------------------------------------------------
# Issue 5: market temporal provenance (Python audit path)
# ---------------------------------------------------------------------------


class TestMarketTemporalProvenance(unittest.TestCase):
    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        _apply_real_migrations(conn)
        return conn

    def _insert(self, conn, quote_id, fetched_at, is_closing=0) -> None:
        conn.execute(
            "INSERT INTO market_quote_pairs (quote_pair_id, game_pk, bookmaker, market, "
            "home_no_vig_prob, away_no_vig_prob, fetched_at_utc, is_opening, is_closing, "
            "is_eligible, created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)",
            (quote_id, "1", "book", "moneyline", 0.55, 0.45, fetched_at, 0, is_closing,
             "2026-08-20T12:00:00Z"),
        )

    def test_quote_before_as_of_accepted(self) -> None:
        from src.prediction_audit import _market_context

        conn = self._conn()
        self._insert(conn, "qp-1", "2026-08-20T17:58:00Z")
        market = _market_context(conn, "1", "qp-1", "2026-08-20T18:00:00Z")
        self.assertIsNotNone(market["at_prediction"])
        self.assertEqual(market["source"], "paired")

    def test_future_quote_rejected(self) -> None:
        from src.prediction_audit import _market_context

        conn = self._conn()
        self._insert(conn, "qp-1", "2026-08-20T18:01:00Z")
        market = _market_context(conn, "1", "qp-1", "2026-08-20T18:00:00Z")
        self.assertIsNone(market["at_prediction"])
        self.assertIsNone(market["source"])

    def test_null_quote_timestamp_rejected(self) -> None:
        # THE loophole: paired quote with NULL fetched_at must not count as
        # prediction-time evidence.
        from src.prediction_audit import _market_context

        conn = self._conn()
        self._insert(conn, "qp-null", None)
        market = _market_context(conn, "1", "qp-null", "2026-08-20T18:00:00Z")
        self.assertIsNone(market["at_prediction"])
        self.assertIsNone(market["source"])

    def test_null_as_of_rejected(self) -> None:
        # Missing prediction timestamp: no temporal validity may be claimed.
        from src.prediction_audit import _market_context

        conn = self._conn()
        self._insert(conn, "qp-1", "2026-08-20T17:58:00Z")
        market = _market_context(conn, "1", "qp-1", None)
        self.assertIsNone(market["at_prediction"])
        self.assertIsNone(market["source"])

    def test_closing_quote_never_substituted_as_at_prediction(self) -> None:
        from src.prediction_audit import _market_context

        conn = self._conn()
        self._insert(conn, "qp-close", "2026-08-20T22:55:00Z", is_closing=1)
        market = _market_context(conn, "1", "qp-close", "2026-08-20T18:00:00Z")
        self.assertIsNone(market["at_prediction"])
        self.assertIsNotNone(market["closing"])
        self.assertEqual(market["closing"]["quote_pair_id"], "qp-close")

    def test_fallback_only_uses_pre_as_of_quotes(self) -> None:
        from src.prediction_audit import _market_context

        conn = self._conn()
        self._insert(conn, "qp-null", None)          # unknown provenance
        self._insert(conn, "qp-late", "2026-08-20T19:00:00Z")  # future
        self._insert(conn, "qp-ok", "2026-08-20T17:30:00Z")    # valid
        market = _market_context(conn, "1", "qp-null", "2026-08-20T18:00:00Z")
        self.assertEqual(market["at_prediction"]["quote_pair_id"], "qp-ok")
        self.assertEqual(market["source"], "nearest_pre_as_of")


if __name__ == "__main__":
    unittest.main()
