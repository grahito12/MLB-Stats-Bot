#!/usr/bin/env python3
"""Train the learned_v2_logistic challenger from the all-game dataset.

Reads a (copy of) the production SQLite DB. NEVER mutates production tables.
Writes a proposal artifact to data/models/. Activation (pointing the live
registry at the artifact) requires separate human approval.

Usage:
  python scripts/train_learned_v2_logistic.py --db data/state.sqlite \\
      --cohort main --out data/models

If data is insufficient, writes an insufficient_data report (no usable artifact).
"""

from __future__ import annotations

import argparse
import os
import sys

# Ensure project root is importable when run as a script.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from src.models.train_learned_v2_logistic import (
    train_learned_v2_logistic,
    write_artifact,
    LEARNED_V2_LOGISTIC_MODEL_ID,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Train learned_v2_logistic challenger.")
    parser.add_argument("--db", required=True, help="Path to a (copy of) the production SQLite DB.")
    parser.add_argument("--cohort", default="main", choices=["main", "close_time", "confirmed_lineup"])
    parser.add_argument("--control-model", default="heuristic_v1", help="Control model_id to read runs for.")
    parser.add_argument("--out", default="data/models", help="Output directory for the proposal artifact.")
    args = parser.parse_args()

    if not os.path.exists(args.db):
        sys.stderr.write(f"DB not found: {args.db}\n")
        return 2

    report = train_learned_v2_logistic(args.db, cohort=args.cohort, model_id_for_dataset=args.control_model)
    out_path = write_artifact(report, args.out)

    status = report.get("status")
    print(f"[{LEARNED_V2_LOGISTIC_MODEL_ID}] status={status}")
    print(f"  artifact: {out_path}")
    print(f"  dataset_rows: {report.get('dataset_row_count', 0)}")
    print(f"  quarantine: {report.get('quarantine_count', 0)}")
    print(f"  fold_count: {report.get('fold_count', 0)}")
    if status == "insufficient_data":
        print(f"  reasons: {report.get('reasons', [])}")
        print("  No usable artifact written. This is a valid scaffold result.")
    else:
        art = report.get("artifact", {})
        oof = report.get("oof_metrics", {})
        print(f"  artifact_hash: {report.get('artifact_hash')}")
        print(f"  oof_rows: {report.get('oof_row_count', 0)}")
        print(f"  oof_metrics: {oof}")
        print("  Artifact is a PROPOSAL. Activation requires separate human approval.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
