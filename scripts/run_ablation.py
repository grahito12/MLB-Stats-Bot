#!/usr/bin/env python3
"""CLI: run P5 chronological ablations and write reports/ablation/.

Runs two ablation schemas:
  1. control-v1-families: the 62-control-feature families (offense/prevention/
     starter/bullpen/form/lineup/schedule/injury/h2h/weather/platoon). V1
     diagnostic neutralization — never modifies live control math.
  2. candidate-v1-families: the P4 candidate families (statcast/arsenal/innings/
     bullpen_quality/lineup/bvp/xera), joined when candidate vectors exist.

Usage:
    python scripts/run_ablation.py --sqlite data/state.sqlite --output reports/ablation
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.eval.ablation import (
    run_ablations,
    write_ablation_report,
    CONTROL_FAMILY_GROUPS,
    CANDIDATE_FAMILY_GROUPS,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="P5 chronological ablations")
    parser.add_argument("--sqlite", default="data/state.sqlite")
    parser.add_argument("--output", default="reports/ablation")
    parser.add_argument("--model-id", default="heuristic_v1")
    parser.add_argument("--cohort", default="main")
    parser.add_argument("--schema", default="both", choices=["both", "control", "candidate"])
    args = parser.parse_args()

    if not os.path.exists(args.sqlite):
        print(f"ERROR: database not found: {args.sqlite}", file=sys.stderr)
        return 1

    os.makedirs(args.output, exist_ok=True)
    wrote: list[str] = []

    if args.schema in ("both", "control"):
        report = run_ablations(
            args.sqlite,
            model_id=args.model_id,
            cohort=args.cohort,
            family_groups=CONTROL_FAMILY_GROUPS,
        )
        md = write_ablation_report(report, args.output)
        wrote.append(md)
        print(f"control-v1 ablation: {md} (rows={report['row_count']}, "
              f"families={len(report['family_ablations'])})")

    if args.schema in ("both", "candidate"):
        report = run_ablations(
            args.sqlite,
            model_id=args.model_id,
            cohort=args.cohort,
            family_groups=CANDIDATE_FAMILY_GROUPS,
        )
        md = write_ablation_report(report, args.output)
        wrote.append(md)
        print(f"candidate-v1 ablation: {md} (rows={report['row_count']}, "
              f"families={len(report['family_ablations'])})")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
