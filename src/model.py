"""Prediction models for MLB matchups."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from statistics import mean
from typing import Any

from .data_loader import PitcherStats, TeamStats
from .features import (
    bullpen_score,
    home_field_adjustment,
    log5_probability,
    offense_score,
    pitcher_score,
    pythagorean_win_pct,
    recent_form_score,
)
from .utils import clamp, confidence_label, format_probability, logistic, safe_float


@dataclass(frozen=True)
class PredictionResult:
    """Final prediction payload for a single matchup."""

    home_team: str
    away_team: str
    predicted_winner: str
    home_win_probability: float
    away_win_probability: float
    confidence: str
    main_factors: list[str]
    rating_difference: float
    components: dict[str, float] = field(default_factory=dict)

    def to_output_lines(self) -> list[str]:
        """Render a CLI-friendly prediction output."""
        lines = [
            f"Home Team: {self.home_team}",
            f"Away Team: {self.away_team}",
            f"Predicted Winner: {self.predicted_winner}",
            f"Home Win Probability: {format_probability(self.home_win_probability)}",
            f"Away Win Probability: {format_probability(self.away_win_probability)}",
            f"Confidence: {self.confidence}",
            "Main Factors:",
        ]
        lines.extend(f"- {factor}" for factor in self.main_factors)
        return lines

    def format(self) -> str:
        """Return a printable multi-line prediction."""
        return "\n".join(self.to_output_lines())


class BaselinePredictionModel:
    """Rule-based MLB model using sabermetric weighted components."""

    DEFAULT_WEIGHTS = {
        "team_strength": 0.30,
        "starting_pitcher": 0.25,
        "offense": 0.20,
        "bullpen": 0.10,
        "recent_form": 0.10,
        "home_field": 0.05,
    }

    def __init__(self, weights: dict[str, float] | None = None) -> None:
        self.weights = weights or self.DEFAULT_WEIGHTS.copy()

    @staticmethod
    def _team_strength(team: TeamStats) -> float:
        pyth = pythagorean_win_pct(team.runs_scored, team.runs_allowed)
        return clamp(pyth * 0.65 + team.win_pct * 0.35, 0.05, 0.95)

    @staticmethod
    def _team_offense(team: TeamStats) -> float:
        return offense_score(team.ops, team.wrc_plus, team.runs_per_game)

    @staticmethod
    def _team_bullpen(team: TeamStats) -> float:
        return bullpen_score(team.bullpen_era, team.bullpen_whip, team.bullpen_recent_usage)

    @staticmethod
    def _team_recent(team: TeamStats) -> float:
        return recent_form_score(team.wins_last_10, team.games_last_10, team.run_diff_last_10)

    @staticmethod
    def _pitcher(pitcher: PitcherStats | None) -> float:
        if pitcher is None:
            return 0.0
        return pitcher_score(pitcher.era, pitcher.whip, pitcher.fip, pitcher.k_bb_ratio)

    def predict(
        self,
        home_team: TeamStats,
        away_team: TeamStats,
        home_pitcher: PitcherStats | None = None,
        away_pitcher: PitcherStats | None = None,
    ) -> PredictionResult:
        """Predict home/away win probability for a matchup."""
        home_strength = self._team_strength(home_team)
        away_strength = self._team_strength(away_team)
        log5_home = log5_probability(home_strength, away_strength)

        components = {
            "team_strength": (log5_home - 0.5) * 5.0,
            "starting_pitcher": self._pitcher(home_pitcher) - self._pitcher(away_pitcher),
            "offense": self._team_offense(home_team) - self._team_offense(away_team),
            "bullpen": self._team_bullpen(home_team) - self._team_bullpen(away_team),
            "recent_form": self._team_recent(home_team) - self._team_recent(away_team),
            "home_field": home_field_adjustment(True),
        }
        rating_difference = sum(
            self.weights.get(name, 0.0) * value for name, value in components.items()
        )
        home_probability = clamp(logistic(rating_difference), 0.05, 0.95)
        away_probability = 1.0 - home_probability
        predicted_winner = home_team.team if home_probability >= 0.5 else away_team.team

        return PredictionResult(
            home_team=home_team.team,
            away_team=away_team.team,
            predicted_winner=predicted_winner,
            home_win_probability=home_probability,
            away_win_probability=away_probability,
            confidence=confidence_label(home_probability),
            main_factors=self._main_factors(components, home_probability >= 0.5),
            rating_difference=rating_difference,
            components=components,
        )

    def _main_factors(self, components: dict[str, float], home_is_winner: bool) -> list[str]:
        labels = {
            "team_strength": "Better Log5/Pythagorean team-strength profile",
            "starting_pitcher": "Better starting pitcher advantage",
            "offense": "Stronger offense based on OPS/wRC+ and runs per game",
            "bullpen": "Stronger bullpen profile",
            "recent_form": "Recent form advantage",
            "home_field": "Slight home field edge",
        }
        directional = []
        for name, value in components.items():
            winner_edge = value if home_is_winner else -value
            if name == "home_field" and not home_is_winner:
                continue
            if winner_edge > 0.03:
                weighted_edge = abs(winner_edge) * self.weights.get(name, 0.0)
                directional.append((weighted_edge, labels[name]))

        directional.sort(reverse=True)
        factors = [label for _, label in directional[:4]]
        return factors or ["Small composite edge across the weighted model"]


def shift_rolling_averages(
    rows: list[dict[str, Any]],
    group_key: str,
    date_key: str,
    stat_keys: list[str],
    window: int = 5,
) -> list[dict[str, Any]]:
    """Create leakage-safe rolling averages using only rows before each date.

    Rows from the same date do not enter each other's rolling window.
    """
    output = [dict(row) for row in rows]
    indexed_rows = list(enumerate(rows))
    by_group: dict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    for index, row in indexed_rows:
        by_group[str(row[group_key])].append((index, row))

    for grouped_rows in by_group.values():
        history: dict[str, list[float]] = {stat: [] for stat in stat_keys}
        sorted_group = sorted(grouped_rows, key=lambda item: str(item[1][date_key]))
        position = 0
        while position < len(sorted_group):
            current_date = str(sorted_group[position][1][date_key])
            same_date: list[tuple[int, dict[str, Any]]] = []
            while position < len(sorted_group) and str(sorted_group[position][1][date_key]) == current_date:
                same_date.append(sorted_group[position])
                position += 1

            for original_index, _ in same_date:
                for stat in stat_keys:
                    prior = history[stat][-window:]
                    output[original_index][f"{stat}_rolling_{window}"] = mean(prior) if prior else None

            for _, row in same_date:
                for stat in stat_keys:
                    history[stat].append(safe_float(row.get(stat), 0.0))

    return output


def build_feature_matrix(
    rows: list[dict[str, Any]],
    feature_columns: list[str],
    target_column: str,
) -> tuple[list[list[float]], list[int]]:
    """Build a numeric feature matrix for scikit-learn models."""
    features = [[safe_float(row.get(column), 0.0) for column in feature_columns] for row in rows]
    target = [int(safe_float(row.get(target_column), 0.0)) for row in rows]
    return features, target


def train_ml_models(
    rows: list[dict[str, Any]],
    feature_columns: list[str],
    target_column: str = "home_win",
) -> dict[str, Any]:
    """Train optional scikit-learn classifiers on pre-game feature rows."""
    try:
        from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
        from sklearn.linear_model import LogisticRegression
    except ImportError as exc:  # pragma: no cover - exercised only without sklearn installed
        raise RuntimeError("Install scikit-learn to train optional ML models.") from exc

    x_train, y_train = build_feature_matrix(rows, feature_columns, target_column)
    models = {
        "logistic_regression": LogisticRegression(max_iter=1000),
        "random_forest": RandomForestClassifier(n_estimators=200, random_state=42),
        "gradient_boosting": GradientBoostingClassifier(random_state=42),
    }
    for model in models.values():
        model.fit(x_train, y_train)
    return models
