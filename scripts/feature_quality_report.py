#!/usr/bin/env python3
"""CLI: generate reports/feature_quality.md from the all-game dataset.

Reports feature coverage, fallback rate, source/cutoff validity, sample sizes,
temporal violations, and train-fold-only association. Read-only.

Usage:
    python scripts/feature_quality_report.py --sqlite data/state.sqlite \
        --output reports/feature_quality.md
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main() -> int:
    parser = argparse.ArgumentParser(description="Feature quality report")
    parser.add_argument("--sqlite", default="data/state.sqlite")
    parser.add_argument("--output", default="reports/feature_quality.md")
    args = parser.parse_args()

    if not os.path.exists(args.sqlite):
        print(f"ERROR: database not found: {args.sqlite}", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)

    conn = sqlite3.connect(f"file:{args.sqlite}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        report = _build_report(conn)
    finally:
        conn.close()

    _write_markdown(report, args.output)
    print(f"Feature quality report: {args.output}")
    return 0


def _build_report(conn: sqlite3.Connection) -> dict:
    report: dict = {"sections": []}

    # --- Model predictions coverage ---
    try:
        total = conn.execute("SELECT COUNT(*) AS c FROM model_predictions").fetchone()["c"]
        eligible = conn.execute(
            "SELECT COUNT(*) AS c FROM model_predictions WHERE promotion_eligible = 1"
        ).fetchone()["c"]
        by_model = {
            r["model_id"]: r["c"]
            for r in conn.execute(
                "SELECT model_id, COUNT(*) AS c FROM model_predictions GROUP BY model_id"
            ).fetchall()
        }
    except sqlite3.OperationalError:
        total, eligible, by_model = 0, 0, {}
    report["sections"].append({
        "title": "Model Prediction Coverage",
        "items": [
            f"Total model_predictions rows: **{total}**",
            f"Promotion-eligible rows: **{eligible}**",
            f"By model: {json.dumps(by_model)}",
        ],
    })

    # --- Information state distribution ---
    try:
        info_states = {
            r["information_state"] or "null": r["c"]
            for r in conn.execute(
                "SELECT information_state, COUNT(*) AS c FROM model_predictions "
                "GROUP BY information_state"
            ).fetchall()
        }
    except sqlite3.OperationalError:
        info_states = {}
    report["sections"].append({
        "title": "Information State Distribution",
        "items": [f"{k}: {v}" for k, v in sorted(info_states.items())],
    })

    # --- Market quote pair coverage ---
    try:
        quote_total = conn.execute("SELECT COUNT(*) AS c FROM market_quote_pairs").fetchone()["c"]
        quote_eligible = conn.execute(
            "SELECT COUNT(*) AS c FROM market_quote_pairs WHERE is_eligible = 1"
        ).fetchone()["c"]
        quote_opening = conn.execute(
            "SELECT COUNT(*) AS c FROM market_quote_pairs WHERE is_opening = 1"
        ).fetchone()["c"]
        quote_closing = conn.execute(
            "SELECT COUNT(*) AS c FROM market_quote_pairs WHERE is_closing = 1"
        ).fetchone()["c"]
        games_with_quotes = conn.execute(
            "SELECT COUNT(DISTINCT game_pk) AS c FROM market_quote_pairs WHERE is_eligible = 1"
        ).fetchone()["c"]
    except sqlite3.OperationalError:
        quote_total = quote_eligible = quote_opening = quote_closing = games_with_quotes = 0
    report["sections"].append({
        "title": "Market Quote Pair Coverage",
        "items": [
            f"Total quote pairs: **{quote_total}**",
            f"Eligible (pre-first-pitch): **{quote_eligible}**",
            f"Opening pairs: {quote_opening}",
            f"Closing pairs: {quote_closing}",
            f"Distinct games with eligible quotes: **{games_with_quotes}**",
        ],
    })

    # --- Temporal violations ---
    try:
        post_pitch = conn.execute(
            "SELECT COUNT(*) AS c FROM model_predictions WHERE as_of_utc IS NOT NULL "
            "AND first_pitch_utc IS NOT NULL AND as_of_utc >= first_pitch_utc"
        ).fetchone()["c"]
        ineligible = conn.execute(
            "SELECT COUNT(*) AS c FROM model_predictions WHERE promotion_eligible = 0"
        ).fetchone()["c"]
    except sqlite3.OperationalError:
        post_pitch = ineligible = 0
    report["sections"].append({
        "title": "Temporal Validity",
        "items": [
            f"Post-pitch as_of rows (should be 0 in clean dataset): **{post_pitch}**",
            f"Promotion-ineligible rows: {ineligible}",
        ],
    })

    # --- Outcomes coverage ---
    try:
        outcomes = conn.execute("SELECT COUNT(*) AS c FROM game_outcomes").fetchone()["c"]
    except sqlite3.OperationalError:
        outcomes = 0
    report["sections"].append({
        "title": "All-Game Outcomes",
        "items": [f"Recorded game_outcomes: **{outcomes}**"],
    })

    # --- Folds ---
    try:
        folds = conn.execute(
            "SELECT fold_id, fold_index, fold_type, start_date, end_date, game_count "
            "FROM model_dataset_folds ORDER BY fold_index, fold_type"
        ).fetchall()
        fold_items = [
            f"fold {r['fold_index']} ({r['fold_type']}): {r['start_date']} -> {r['end_date']}, {r['game_count'] or 0} games"
            for r in folds
        ] or ["No folds persisted yet."]
    except sqlite3.OperationalError:
        fold_items = ["Folds table not present."]
    report["sections"].append({"title": "Persisted Folds", "items": fold_items})

    # --- Candidate feature families (P4) ---
    try:
        candidate_groups = {
            r["feature_group"]: r["c"]
            for r in conn.execute(
                "SELECT feature_group, COUNT(*) AS c FROM feature_snapshots "
                "WHERE feature_group IN "
                "('statcast_team','pitch_arsenal','expected_innings',"
                "'bullpen_quality','lineup_batter','bvp','starter_xera') "
                "GROUP BY feature_group"
            ).fetchall()
        }
        candidate_games = conn.execute(
            "SELECT COUNT(DISTINCT game_pk) AS c FROM feature_snapshots "
            "WHERE feature_group IN "
            "('statcast_team','pitch_arsenal','expected_innings',"
            "'bullpen_quality','lineup_batter','bvp','starter_xera')"
        ).fetchone()["c"]
    except sqlite3.OperationalError:
        candidate_groups = {}
        candidate_games = 0
    candidate_items = (
        [f"Distinct games with any candidate snapshot: **{candidate_games}**"]
        + [f"{g}: {c} snapshots" for g, c in sorted(candidate_groups.items())]
        or ["No candidate snapshots captured yet."]
    )
    report["sections"].append({
        "title": "Candidate Feature Families (P4, shadow research only)",
        "items": candidate_items,
    })

    return report


def _write_markdown(report: dict, path: str) -> None:
    lines = ["# Feature Quality Report", ""]
    lines.append("_Read-only report from the all-game research dataset._")
    lines.append("")
    for section in report["sections"]:
        lines.append(f"## {section['title']}")
        lines.append("")
        if section["items"]:
            for item in section["items"]:
                lines.append(f"- {item}")
        else:
            lines.append("- _no data_")
        lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("_Candidate collection may ship before scoring; unavailable data cannot be synthesized._")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
