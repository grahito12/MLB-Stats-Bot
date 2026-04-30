import unittest

from src.features import (
    get_pitcher_rest_days,
    get_team_schedule_fatigue,
    log5_probability,
    pythagorean_win_pct,
)


class FeatureFormulaTests(unittest.TestCase):
    def test_pythagorean_even_runs_is_half(self) -> None:
        self.assertAlmostEqual(pythagorean_win_pct(700, 700), 0.5)

    def test_pythagorean_rewards_more_runs_scored(self) -> None:
        self.assertGreater(pythagorean_win_pct(800, 650), 0.5)

    def test_log5_even_teams_is_half(self) -> None:
        self.assertAlmostEqual(log5_probability(0.6, 0.6), 0.5)

    def test_log5_stronger_team_above_half(self) -> None:
        self.assertGreater(log5_probability(0.6, 0.5), 0.5)

    def test_pitcher_rest_days_uses_last_prior_appearance(self) -> None:
        schedule = [
            {"date": "2026-04-21", "pitcher_id": 99},
            {"date": "2026-04-25", "pitcher_id": 42},
            {"date": "2026-04-27", "pitcher_id": 7},
        ]

        self.assertEqual(get_pitcher_rest_days(42, "2026-04-30", schedule), 4)

    def test_pitcher_rest_days_returns_normal_rest_when_missing(self) -> None:
        self.assertEqual(get_pitcher_rest_days(42, "2026-04-30", []), 5)

    def test_team_schedule_fatigue_detects_doubleheader_and_road_trip(self) -> None:
        schedule = [
            {"date": "2026-04-19", "away_team_id": "LAD", "home_team_id": "ARI"},
            {"date": "2026-04-20", "away_team_id": "LAD", "home_team_id": "SF"},
            {"date": "2026-04-21", "away_team_id": "LAD", "home_team_id": "SD"},
            {"date": "2026-04-22", "away_team_id": "LAD", "home_team_id": "COL"},
            {"date": "2026-04-23", "away_team_id": "LAD", "home_team_id": "CHC"},
            {"date": "2026-04-24", "away_team_id": "LAD", "home_team_id": "MIL"},
            {"date": "2026-04-25", "away_team_id": "LAD", "home_team_id": "STL"},
            {"date": "2026-04-26", "away_team_id": "LAD", "home_team_id": "CIN"},
            {"date": "2026-04-27", "away_team_id": "LAD", "home_team_id": "PIT"},
            {"date": "2026-04-28", "away_team_id": "LAD", "home_team_id": "NYM"},
            {"date": "2026-04-28", "away_team_id": "LAD", "home_team_id": "NYM"},
        ]

        fatigue = get_team_schedule_fatigue("LAD", "2026-04-30", schedule)

        self.assertEqual(fatigue["rest_days"], 1)
        self.assertEqual(fatigue["road_streak"], 10)
        self.assertEqual(fatigue["recent_game_count"], 10)
        self.assertTrue(fatigue["doubleheader_last_3_days"])
        self.assertEqual(fatigue["fatigue_level"], "high")

    def test_team_schedule_fatigue_low_for_restful_schedule(self) -> None:
        schedule = [
            {"date": "2026-04-20", "away_team_id": "BOS", "home_team_id": "NYY"},
            {"date": "2026-04-24", "away_team_id": "TOR", "home_team_id": "BOS"},
        ]

        fatigue = get_team_schedule_fatigue("BOS", "2026-04-30", schedule)

        self.assertEqual(fatigue["rest_days"], 5)
        self.assertEqual(fatigue["road_streak"], 0)
        self.assertEqual(fatigue["recent_game_count"], 2)
        self.assertEqual(fatigue["fatigue_level"], "low")


if __name__ == "__main__":
    unittest.main()
