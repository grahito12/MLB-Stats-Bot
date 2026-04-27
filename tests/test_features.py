import unittest

from src.features import log5_probability, pythagorean_win_pct


class FeatureFormulaTests(unittest.TestCase):
    def test_pythagorean_even_runs_is_half(self) -> None:
        self.assertAlmostEqual(pythagorean_win_pct(700, 700), 0.5)

    def test_pythagorean_rewards_more_runs_scored(self) -> None:
        self.assertGreater(pythagorean_win_pct(800, 650), 0.5)

    def test_log5_even_teams_is_half(self) -> None:
        self.assertAlmostEqual(log5_probability(0.6, 0.6), 0.5)

    def test_log5_stronger_team_above_half(self) -> None:
        self.assertGreater(log5_probability(0.6, 0.5), 0.5)


if __name__ == "__main__":
    unittest.main()
