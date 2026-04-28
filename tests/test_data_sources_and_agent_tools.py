import unittest

from src.agent_tools import (
    explain_market_value,
    explain_prediction,
    get_team_offense_splits,
    predict_moneyline,
    predict_total_runs,
)
from src.data_sources.odds_client import extract_market_snapshot
from src.data_sources.retrosheet_loader import load_game_logs, team_recent_form
from src.data_sources.statcast_loader import load_statcast_csv, summarize_statcast
from src.knowledge.baseball_knowledge import answer_baseball_question
from src.telegram_agent_bridge import list_games, moneyline, total_runs


class KnowledgeLayerTests(unittest.TestCase):
    def test_sabermetrics_question_retrieval(self) -> None:
        answer = answer_baseball_question("Why is wRC+ better than OPS for offense evaluation?")
        self.assertTrue(answer["sources"])
        self.assertIn("wRC+", answer["answer"])


class DataSourceLoaderTests(unittest.TestCase):
    def test_statcast_summary(self) -> None:
        summary = summarize_statcast(load_statcast_csv())
        self.assertGreater(summary["pitches"], 0)
        self.assertGreater(summary["hard_hit_rate"], 0)
        self.assertIn("FF", summary["pitch_type_mix"])

    def test_retrosheet_recent_form_is_before_date(self) -> None:
        games = load_game_logs()
        form = team_recent_form(games, "Los Angeles Dodgers", before_date="2025-04-03", last_n_games=10)
        self.assertEqual(form["games"], 2)
        self.assertEqual(form["wins"], 1)

    def test_odds_market_snapshot(self) -> None:
        event = {
            "id": "abc",
            "home_team": "Los Angeles Dodgers",
            "away_team": "New York Yankees",
            "bookmakers": [
                {
                    "markets": [
                        {"key": "h2h", "outcomes": [{"name": "Los Angeles Dodgers", "price": -120}]},
                        {"key": "totals", "outcomes": [{"name": "Over", "price": -110, "point": 8.5}]},
                    ]
                }
            ],
        }
        snapshot = extract_market_snapshot(event)
        self.assertEqual(snapshot["moneyline"]["Los Angeles Dodgers"], -120)
        self.assertEqual(snapshot["totals"]["over"]["point"], 8.5)


class AgentToolTests(unittest.TestCase):
    def test_agent_predictions_from_sample_data(self) -> None:
        moneyline = predict_moneyline(0)
        totals = predict_total_runs(0)
        self.assertIn("home_win_probability", moneyline)
        self.assertIn("projected_total_runs", totals)
        self.assertIn(8.5, totals["over_probabilities"])

    def test_explain_prediction_output_contract(self) -> None:
        output = explain_prediction(0)
        self.assertIn("MLB Game Analysis:", output)
        self.assertIn("Moneyline prediction:", output)
        self.assertIn("Total runs prediction:", output)
        self.assertIn("No-bet flag:", output)

    def test_market_value_edge(self) -> None:
        edge = explain_market_value(0.58, -110)
        self.assertGreater(edge["edge"], 0)

    def test_team_offense_splits(self) -> None:
        split = get_team_offense_splits("Los Angeles Dodgers", "RHP")
        self.assertEqual(split["pitcher_hand"], "RHP")
        self.assertGreater(split["ops"], 0)

    def test_telegram_bridge_minimal_outputs(self) -> None:
        games = list_games()
        self.assertGreaterEqual(len(games["games"]), 1)
        self.assertIn("Pick:", moneyline("0")["text"])
        self.assertIn("Over:", total_runs("0")["text"])


if __name__ == "__main__":
    unittest.main()
