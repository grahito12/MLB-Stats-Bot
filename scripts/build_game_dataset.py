#!/usr/bin/env python3
"""CLI: build the all-game research dataset, folds, and baseline comparison.

Read-only against a (copy of) the production SQLite DB. Never mutates
production tables. Emits INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE when
promotion-safe history is insufficient, and continues with forward
capture/scaffolding only.

Usage:
    python scripts/build_game_dataset.py --sqlite data/state.sqlite \
        --output reports/dataset --model heuristic_v1 --cohort main
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# Ensure repo root is on sys.path for `from src.` imports.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.dataset.build_game_dataset import (
    build_game_dataset,
    build_folds,
    write_dataset_manifest,
)
from src.eval.compare_models import compare_models


def main() -> int:
    parser = argparse.ArgumentParser(description="Build all-game research dataset + baselines")
    parser.add_argument("--sqlite", default="data/state.sqlite", help="Path to (a copy of) state.sqlite")
    parser.add_argument("--output", default="reports/dataset", help="Output directory")
    parser.add_argument("--model", default="heuristic_v1", help="Model ID to export")
    parser.add_argument("--cohort", default="main", choices=["main", "close_time", "confirmed_lineup"])
    parser.add_argument("--compare", action="store_true", help="Also run baseline comparison")
    args = parser.parse_args()

    if not os.path.exists(args.sqlite):
        print(f"ERROR: database not found: {args.sqlite}", file=sys.stderr)
        return 1

    os.makedirs(args.output, exist_ok=True)

    clean, quarantined = build_game_dataset(args.sqlite, model_id=args.model, cohort=args.cohort)
    folds, dataset_hash = build_folds(clean)
    manifest_path = write_dataset_manifest(
        clean, quarantined, folds, dataset_hash, args.output,
        model_id=args.model, cohort=args.cohort,
    )

    print(f"Dataset: {len(clean)} clean rows, {len(quarantined)} quarantined")
    print(f"Folds: {len(folds)} (holdout={'yes' if any(f['fold_type']=='holdout' for f in folds) else 'no'})")
    print(f"Manifest: {manifest_path}")

    if len(clean) == 0:
        print("INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE")
        print("  No promotion-eligible pregame rows with valid outcomes yet.")
        print("  Forward capture/scaffolding continues; no rows reconstructed from selected picks.")
        _write_insufficient_report(args.output, args.model, args.cohort, len(quarantined))
        return 0

    if args.compare:
        print("\nScoring baselines...")
        comparison = compare_models(args.sqlite, model_id=args.model, cohort=args.cohort)
        comparison_path = os.path.join(args.output, f"comparison_{args.model}_{args.cohort}.json")
        with open(comparison_path, "w") as f:
            json.dump(comparison, f, indent=2, default=str)
        print(f"Comparison: {comparison_path}")
        ctrl = comparison.get("control", {})
        print(f"  Control mean Brier: {ctrl.get('mean_brier')}")
        print(f"  Control mean log loss: {ctrl.get('mean_log_loss')}")
        print(f"  Control mean accuracy: {ctrl.get('mean_accuracy')}")
        ci = comparison.get("common_intersection", {})
        print(f"  Common-intersection n: {ci.get('total_n')}")

    return 0


def _write_insufficient_report(output_dir: str, model_id: str, cohort: str, quarantine_count: int) -> None:
    report = {
        "recommendation": "INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE",
        "model_id": model_id,
        "cohort": cohort,
        "clean_rows": 0,
        "quarantine_count": quarantine_count,
        "reason": "No promotion-eligible pregame rows with valid outcomes. "
                  "Forward capture continues; no rows reconstructed from selected picks.",
    }
    path = os.path.join(output_dir, f"insufficient_{model_id}_{cohort}.json")
    with open(path, "w") as f:
        json.dump(report, f, indent=2)


if __name__ == "__main__":
    raise SystemExit(main())
