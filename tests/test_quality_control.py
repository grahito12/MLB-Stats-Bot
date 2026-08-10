import unittest
from datetime import datetime, timedelta, timezone

from src.quality_control import (
    apply_confidence_downgrade,
    calculate_data_quality_score,
    check_prediction_inputs,
    compute_risk_uncertainty,
    detect_factor_conflicts,
    generate_quality_report,
)


def _fresh_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stale_timestamp() -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()


def _context() -> dict:
    timestamp = _fresh_timestamp()
    return {
        "probable_pitchers": {
            "home": {"pitcher": "Home Ace", "confirmed": True},
            "away": {"pitcher": "Away Ace", "confirmed": True},
        },
        "lineup": {
            "home": {"team": "Home", "confirmed": True},
            "away": {"team": "Away", "confirmed": True},
        },
        "weather": {"available": True, "data_timestamp": timestamp, "roof": "open"},
        "market": {
            "available": True,
            "home_moneyline": "-120",
            "away_moneyline": "+110",
            "market_total": 8.5,
            "opening_total": 8.0,
            "current_total": 8.5,
            "over_odds": "-110",
            "under_odds": "-110",
            "data_timestamp": timestamp,
        },
        "bullpen": {
            "home": {"available": True},
            "away": {"available": True},
        },
        "park": {"available": True, "park": "Sample Park"},
        "injury_news": {"available": True},
        "calibration": {"supports_high_confidence": True},
    }


def _prediction(**overrides) -> dict:
    payload = {
        "confidence": "High",
        "model_edge": 0.05,
        "final_lean": "Home Team",
        "market_type": "moneyline",
    }
    payload.update(overrides)
    return payload


class TestDetectFactorConflicts(unittest.TestCase):
    """Tests for detect_factor_conflicts."""

    def test_aligned_components(self) -> None:
        """All components pointing the same direction → no conflicts."""
        ctx = _context()
        ctx["model_breakdown"] = {
            "starterEdge": 0.20,
            "lineupEdge": 0.08,
            "bullpenEdge": 0.05,
            "offenseEdge": 0.10,
        }
        result = detect_factor_conflicts(_prediction(), generate_quality_report(ctx), ctx)
        self.assertEqual(result["conflict_count"], 0)
        self.assertEqual(result["component_alignment"], "aligned")

    def test_strong_disagreement(self) -> None:
        """Starter favors pick but offense opposes → strong disagreement."""
        ctx = _context()
        ctx["model_breakdown"] = {
            "starterEdge": 0.25,
            "lineupEdge": 0.02,
            "bullpenEdge": 0.02,
            "offenseEdge": -0.20,
        }
        result = detect_factor_conflicts(_prediction(), generate_quality_report(ctx), ctx)
        self.assertGreater(result["conflict_count"], 0)
        self.assertEqual(result["component_alignment"], "strong_disagreement")
        self.assertGreater(result["conflict_score"], 5)

    def test_mild_disagreement(self) -> None:
        """Small opposing edges → mild disagreement."""
        ctx = _context()
        ctx["model_breakdown"] = {
            "starterEdge": 0.10,
            "lineupEdge": 0.02,
            "bullpenEdge": 0.02,
            "offenseEdge": -0.08,
        }
        result = detect_factor_conflicts(_prediction(), generate_quality_report(ctx), ctx)
        self.assertEqual(result["component_alignment"], "mild_disagreement")

    def test_model_vs_market_conflict(self) -> None:
        """Model components positive but market edge negative."""
        ctx = _context()
        ctx["model_breakdown"] = {
            "starterEdge": 0.20,
            "lineupEdge": 0.08,
            "bullpenEdge": 0.05,
            "offenseEdge": 0.10,
        }
        ctx["market_comparison"] = {
            "moneyline": {"pick_edge": -0.05},
        }
        result = detect_factor_conflicts(_prediction(), generate_quality_report(ctx), ctx)
        self.assertTrue(any("market" in c.lower() for c in result["conflicts"]))

    def test_high_variance_components(self) -> None:
        """Three or more extreme edges → overfitting warning."""
        ctx = _context()
        ctx["model_breakdown"] = {
            "starterEdge": 0.25,
            "lineupEdge": 0.22,
            "bullpenEdge": 0.21,
            "offenseEdge": 0.01,
        }
        result = detect_factor_conflicts(_prediction(), generate_quality_report(ctx), ctx)
        self.assertTrue(any("overfitting" in c.lower() for c in result["conflicts"]))

    def test_empty_breakdown(self) -> None:
        """No model breakdown → aligned with zero conflicts."""
        result = detect_factor_conflicts(_prediction(), generate_quality_report(_context()), _context())
        self.assertEqual(result["conflict_count"], 0)
        self.assertEqual(result["component_alignment"], "aligned")


class TestRiskUncertaintyWithConflicts(unittest.TestCase):
    """Test that factor_conflict_risk is included in risk uncertainty."""

    def test_conflict_adds_to_risk(self) -> None:
        ctx = _context()
        ctx["model_breakdown"] = {
            "starterEdge": 0.25,
            "lineupEdge": 0.02,
            "bullpenEdge": 0.02,
            "offenseEdge": -0.20,
        }
        report = generate_quality_report(ctx)
        result = compute_risk_uncertainty(_prediction(), report, ctx)
        self.assertIn("factor_conflicts", result)
        self.assertIn("factor_conflict_risk", result["components"])
        self.assertGreater(result["components"]["factor_conflict_risk"], 0)

    def test_aligned_has_zero_conflict_risk(self) -> None:
        ctx = _context()
        ctx["model_breakdown"] = {
            "starterEdge": 0.15,
            "lineupEdge": 0.08,
            "bullpenEdge": 0.05,
            "offenseEdge": 0.10,
        }
        report = generate_quality_report(ctx)
        result = compute_risk_uncertainty(_prediction(), report, ctx)
        self.assertEqual(result["components"]["factor_conflict_risk"], 0.0)


class QualityControlTests(unittest.TestCase):
    def test_good_quality_score(self) -> None:
        context = _context()
        checks = check_prediction_inputs(context)
        self.assertEqual(checks["probable_pitchers"], "Confirmed")
        self.assertEqual(calculate_data_quality_score(context), 100)

    def test_high_confidence_opener_reduces_quality_score(self) -> None:
        context = _context()
        context["opener_situation"] = {
            "away": {"is_opener": True, "pitcher_role": "opener", "confidence": "high"},
            "home": {"is_opener": False, "pitcher_role": "starter", "confidence": "low"},
        }

        report = generate_quality_report(context)

        self.assertEqual(report["score"], 90)
        self.assertEqual(report["opener_situation"], "high")
        self.assertIn("opener_situation", report["no_bet_considerations"])

    def test_medium_confidence_opener_reduces_quality_score(self) -> None:
        context = _context()
        context["opener_situation"] = {
            "away": {"is_opener": True, "pitcher_role": "opener", "confidence": "medium"},
        }

        report = generate_quality_report(context)

        self.assertEqual(report["score"], 95)
        self.assertEqual(report["opener_situation"], "medium")

    def test_preferred_market_total_adds_quality_note(self) -> None:
        context = _context()
        context["market"]["market_total"] = 8.0
        report = generate_quality_report(context)

        self.assertEqual(report["score"], 100)
        self.assertIn("market total 8.0-8.5 preferred", report["no_bet_considerations"])

    def test_high_market_total_penalizes_quality_and_adds_caution(self) -> None:
        context = _context()
        context["market"]["market_total"] = 10.0
        report = generate_quality_report(context)

        self.assertEqual(report["score"], 92)
        self.assertIn("market total above 9.5: high-run environment caution", report["no_bet_considerations"])

    def test_market_total_95_and_missing_total_are_neutral(self) -> None:
        context = _context()
        context["market"]["market_total"] = 9.5
        self.assertEqual(calculate_data_quality_score(context), 95)
        del context["market"]["market_total"]
        del context["market"]["current_total"]
        self.assertEqual(calculate_data_quality_score(context), 95)

    def test_missing_probable_pitcher_returns_no_bet(self) -> None:
        context = _context()
        context["probable_pitchers"]["away"] = None
        result = apply_confidence_downgrade(_prediction(), generate_quality_report(context))
        self.assertEqual(result["decision"], "NO BET")
        self.assertIn("probable pitcher missing", result["decision_reason"])

    def test_stale_odds_downgrades_confidence(self) -> None:
        context = _context()
        context["market"]["data_timestamp"] = _stale_timestamp()
        result = apply_confidence_downgrade(_prediction(), generate_quality_report(context))
        self.assertEqual(result["confidence"], "Medium")
        self.assertIn("odds stale", result["confidence_adjustments"][0])

    def test_missing_lineup_caps_confidence_at_medium(self) -> None:
        context = _context()
        context["lineup"]["home"] = None
        result = apply_confidence_downgrade(_prediction(), generate_quality_report(context))
        self.assertEqual(result["confidence"], "Medium")

    def test_low_edge_returns_no_bet(self) -> None:
        result = apply_confidence_downgrade(_prediction(model_edge=0.03), generate_quality_report(_context()))
        self.assertEqual(result["decision"], "NO BET")
        self.assertIn("model edge below 5%", result["decision_reason"])

    def test_moneyline_edge_threshold_reads_dashboard_settings(self) -> None:
        import json
        from tempfile import TemporaryDirectory
        from pathlib import Path
        from unittest.mock import patch

        with TemporaryDirectory() as tmp:
            settings_path = Path(tmp) / "dashboard_settings.json"
            settings_path.write_text(json.dumps({"minimum_moneyline_edge": 0.05}))
            with patch("src.quality_control.data_path", return_value=settings_path):
                result = apply_confidence_downgrade(_prediction(model_edge=0.045), generate_quality_report(_context()))

        self.assertEqual(result["decision"], "NO BET")
        self.assertIn("model edge below 5%", result["decision_reason"])

    def test_low_data_quality_score_returns_no_bet(self) -> None:
        context = _context()
        context["weather"] = {"available": False}
        context["market"] = {"available": False}
        context["bullpen"] = {"home": {"available": False}, "away": {"available": False}}
        report = generate_quality_report(context)
        self.assertLess(report["score"], 60)
        result = apply_confidence_downgrade(_prediction(), report)
        self.assertEqual(result["decision"], "NO BET")
        self.assertIn("data quality score below 60", result["decision_reason"])

    def test_good_quality_data_allows_normal_prediction(self) -> None:
        result = apply_confidence_downgrade(_prediction(), generate_quality_report(_context()))
        self.assertEqual(result["decision"], "BET")
        self.assertEqual(result["confidence"], "High")
        self.assertFalse(result["no_bet"])

    def test_totals_small_market_difference_returns_no_bet_old(self) -> None:
        pass  # totals market removed


if __name__ == "__main__":
    unittest.main()
