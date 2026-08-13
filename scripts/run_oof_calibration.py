#!/usr/bin/env python3
"""CLI: run P6 all-game OOF calibration and write a PROPOSAL artifact.

Reads model_predictions + outcomes from a (copy of) the production DB via the P1
dataset builder. Writes a proposal artifact to data/models/ ONLY — never touches
the live V1 calibration files (calibration_maps.json / calibration_meta.json /
calibration_map.json), the model registry, or env vars. Activation requires
separate human approval.

Usage:
    python scripts/run_oof_calibration.py --sqlite data/state.sqlite --output data/models
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.eval.oof_calibration import run_oof_calibration, write_proposal_artifact


def main() -> int:
    parser = argparse.ArgumentParser(description="P6 all-game OOF calibration")
    parser.add_argument("--sqlite", default="data/state.sqlite")
    parser.add_argument("--output", default="data/models")
    parser.add_argument("--model-id", default="heuristic_v1")
    parser.add_argument("--cohort", default="main")
    parser.add_argument(
        "--target-probability",
        default="raw_home_probability",
        choices=["raw_home_probability", "calibrated_home_probability"],
    )
    args = parser.parse_args()

    if not os.path.exists(args.sqlite):
        print(f"ERROR: database not found: {args.sqlite}", file=sys.stderr)
        return 1

    report = run_oof_calibration(
        args.sqlite,
        model_id=args.model_id,
        cohort=args.cohort,
        target_probability=args.target_probability,
    )
    path = write_proposal_artifact(report, args.output)
    status = report.get("status")
    method = report.get("final_method") or report.get("selected_method")
    print(
        f"OOF calibration: {path}\n"
        f"  status={status} method={method} "
        f"pairs={report.get('pre_holdout_oof_pairs', 0)}"
    )
    if status == "trained":
        hb = report.get("holdout_metrics_calibrated", {})
        hi = report.get("holdout_metrics_identity", {})
        print(
            f"  prequential brier by method: {report.get('method_prequential_brier')}"
        )
        print(
            f"  holdout identity n={hi.get('n')} brier={hi.get('brier')} | "
            f"calibrated n={hb.get('n')} brier={hb.get('brier')}"
        )
    else:
        print(f"  reasons={report.get('reasons')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
