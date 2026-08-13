"""Read-only all-game dataset builder for chronological model evaluation.

Joins pregame prediction runs to outcomes only during export. Never mutates
production tables. The dataset is the honest research truth table — one
deterministic row per game for the main cohort, with separate close-time and
confirmed-lineup cohorts.
"""

from .build_game_dataset import (
    build_game_dataset,
    select_main_cohort_row,
    quarantine_row,
    build_folds,
    write_dataset_manifest,
)

__all__ = [
    "build_game_dataset",
    "select_main_cohort_row",
    "quarantine_row",
    "build_folds",
    "write_dataset_manifest",
]
