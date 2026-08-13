#!/usr/bin/env python3
"""P7 report generator CLI.

Reads a (copy of) the production SQLite DB and writes all P7 reports +
the evidence-bound recommendation to reports/. Never mutates production
tables. No code change activates a model automatically.

Usage:
  python scripts/run_p7_reports.py --sqlite data/state.sqlite --output reports
  python scripts/run_p7_reports.py --sqlite /tmp/state-copy.sqlite --model-id heuristic_v1
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.eval.generate_p7_reports import generate_p7_reports


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate P7 final reports.")
    parser.add_argument(
        "--sqlite", required=True,
        help="Path to SQLite DB (a copy of production; never live data/state.sqlite).",
    )
    parser.add_argument(
        "--output", default="reports",
        help="Output directory for reports (default: reports).",
    )
    parser.add_argument(
        "--model-id", default="heuristic_v1",
        help="Control model ID to score (default: heuristic_v1).",
    )
    parser.add_argument(
        "--cohort", default="main",
        help="Dataset cohort (default: main).",
    )
    args = parser.parse_args(argv)

    summary = generate_p7_reports(
        db_path=args.sqlite,
        output_dir=args.output,
        model_id=args.model_id,
        cohort=args.cohort,
    )

    rec = summary["recommendation"]
    print(f"Recommendation: {rec['recommendation']}")
    print(f"  holdout rows: {rec['holdout_rows']} / min {rec['min_holdout_rows']}")
    print(f"  promotion_eligible: {rec['promotion_eligible']}")
    print("Reports written:")
    for name, path in sorted(summary["report_paths"].items()):
        print(f"  {name}: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
