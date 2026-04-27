import unittest

from src.data_loader import find_pitcher, find_team, load_pitcher_stats, load_team_stats
from src.model import BaselinePredictionModel
from src.odds import (
    american_odds_to_implied_probability,
    calculate_edge,
    decimal_odds_to_implied_probability,
)


class OddsTests(unittest.TestCase):
    def test_american_odds_to_implied_probability(self) -> None:
        self.assertAlmostEqual(american_odds_to_implied_probability("+100"), 0.5)
        self.assertAlmostEqual(american_odds_to_implied_probability("-150"), 0.6)

    def test_decimal_odds_to_implied_probability(self) -> None:
        self.assertAlmostEqual(decimal_odds_to_implied_probability("2.00"), 0.5)

    def test_calculate_edge(self) -> None:
        self.assertAlmostEqual(calculate_edge(0.58, 0.52), 0.06)


class PredictionOutputTests(unittest.TestCase):
    def test_prediction_output_format(self) -> None:
        teams = load_team_stats()
        pitchers = load_pitcher_stats()
        result = BaselinePredictionModel().predict(
            find_team(teams, "Los Angeles Dodgers"),
            find_team(teams, "New York Yankees"),
            find_pitcher(pitchers, "Yoshinobu Yamamoto"),
            find_pitcher(pitchers, "Gerrit Cole"),
        )
        output = result.format()

        self.assertIn("Home Team: Los Angeles Dodgers", output)
        self.assertIn("Away Team: New York Yankees", output)
        self.assertIn("Predicted Winner:", output)
        self.assertIn("Home Win Probability:", output)
        self.assertIn("Main Factors:", output)


if __name__ == "__main__":
    unittest.main()
