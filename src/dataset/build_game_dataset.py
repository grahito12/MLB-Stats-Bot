"""Read-only all-game dataset builder.

Reads model_predictions + prediction_runs + game_outcomes + market_quote_pairs
from a (copy of) the production SQLite DB and produces a versioned JSONL/CSV
research dataset plus a manifest. NEVER mutates production tables.

Cohorts:
  - main: exactly one deterministic run per game_pk (first valid pregame run
    for the control model). Promotion-eligible only.
  - close_time: same selection but restricted to close_time information state.
  - confirmed_lineup: restricted to confirmed_lineup information state.

Quarantine rows with missing/invalid first pitch, post-pitch as-of, future
source timestamp, outcome conflict, duplicate game identity, or unverifiable
feature provenance. Never fill historical timestamps, quotes, or lineups.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Iterable

from src.walk_forward_backtest import generate_walk_forward_dates

MANIFEST_VERSION = "game-dataset-v1"
MIN_FOLD_STEP_DAYS = 7
HOLDOUT_FRACTION = 0.2


@dataclass
class DatasetRow:
    """One all-game research row: pregame prediction joined to outcome."""

    game_pk: str
    date_ymd: str
    model_id: str
    run_id: str
    as_of_utc: str | None
    first_pitch_utc: str | None
    information_state: str
    promotion_eligible: bool
    raw_home_probability: float | None
    raw_away_probability: float | None
    calibrated_home_probability: float | None
    calibrated_away_probability: float | None
    pick_side: str | None
    pick_team_id: str | None
    winner_team_id: str | None
    home_won: bool | None
    home_team_id: str | None
    away_team_id: str | None
    market_no_vig_home_prob: float | None
    market_no_vig_away_prob: float | None
    paired_quote_pair_id: str | None
    snapshot_hash: str | None
    feature_vector_hash: str | None
    feature_vector: dict[str, Any] | None = None
    quarantine_reason: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "game_pk": self.game_pk,
            "date_ymd": self.date_ymd,
            "model_id": self.model_id,
            "run_id": self.run_id,
            "as_of_utc": self.as_of_utc,
            "first_pitch_utc": self.first_pitch_utc,
            "information_state": self.information_state,
            "promotion_eligible": int(self.promotion_eligible),
            "raw_home_probability": self.raw_home_probability,
            "raw_away_probability": self.raw_away_probability,
            "calibrated_home_probability": self.calibrated_home_probability,
            "calibrated_away_probability": self.calibrated_away_probability,
            "pick_side": self.pick_side,
            "pick_team_id": self.pick_team_id,
            "winner_team_id": self.winner_team_id,
            "home_won": int(self.home_won) if self.home_won is not None else None,
            "home_team_id": self.home_team_id,
            "away_team_id": self.away_team_id,
            "market_no_vig_home_prob": self.market_no_vig_home_prob,
            "market_no_vig_away_prob": self.market_no_vig_away_prob,
            "paired_quote_pair_id": self.paired_quote_pair_id,
            "snapshot_hash": self.snapshot_hash,
            "feature_vector_hash": self.feature_vector_hash,
            "quarantine_reason": self.quarantine_reason,
            **self.extra,
        }


def _parse_ts(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def _parse_feature_vector(raw: str | None) -> dict[str, Any] | None:
    """Parse the stored normalized_feature_vector JSON for a run. None if absent."""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except (ValueError, TypeError):
        return None


def quarantine_row(run: dict[str, Any], outcome: dict[str, Any] | None) -> str | None:
    """Return a quarantine reason if the row is unusable, else None.

    Checks: missing/invalid first pitch, post-pitch as-of, future source
    timestamp, outcome conflict, missing outcome label. Never fills history.
    """
    first_pitch = _parse_ts(run.get("first_pitch_utc"))
    as_of = _parse_ts(run.get("as_of_utc"))

    if not first_pitch:
        return "missing_first_pitch"
    if not as_of:
        return "missing_as_of"
    if as_of >= first_pitch:
        return "post_pitch_as_of"
    # Future source timestamp: producer claims evidence from after first pitch.
    producer = _parse_ts(run.get("producer_timestamp_utc") or run.get("prediction_timestamp_utc"))
    if producer and producer >= first_pitch:
        return "future_source_timestamp"

    if outcome is None:
        return "missing_outcome"
    if outcome.get("winner_team_id") is None and outcome.get("home_score") == outcome.get("away_score"):
        return "outcome_tie_or_unknown"

    return None


def select_main_cohort_row(
    runs: list[dict[str, Any]],
    outcomes: dict[str, dict[str, Any]],
    quotes_by_game: dict[str, dict[str, Any]],
) -> tuple[DatasetRow | None, str | None]:
    """Select exactly one deterministic run per game for the main cohort.

    Picks the FIRST valid promotion-eligible pregame run (earliest as_of_utc).
    Returns (row, quarantine_reason). If no eligible run exists, returns the
    best candidate with a quarantine reason.
    """
    eligible = [r for r in runs if r.get("promotion_eligible")]
    pool = eligible or runs
    if not pool:
        return None, "no_runs"

    # Deterministic: earliest as_of_utc, then earliest run_id.
    def sort_key(r: dict[str, Any]) -> tuple:
        return (r.get("as_of_utc") or "9999", r.get("run_id") or "")

    pool.sort(key=sort_key)
    run = pool[0]
    game_pk = str(run["game_pk"])
    outcome = outcomes.get(game_pk)
    quote = quotes_by_game.get(game_pk, {}).get(run.get("as_of_utc"))

    reason = quarantine_row(run, outcome)
    # Eligibility invariant: a fallback row selected because NO promotion-
    # eligible run exists must never enter the clean dataset, even when it is
    # temporally valid and has an outcome. Quarantine it with a stable reason
    # so it stays auditable instead of leaking or vanishing.
    if reason is None and not run.get("promotion_eligible"):
        reason = "not_promotion_eligible"
    home_team_id = str(run.get("home_team_id") or outcome.get("home_team_id") or "") if outcome else None
    away_team_id = str(run.get("away_team_id") or outcome.get("away_team_id") or "") if outcome else None

    home_won = None
    winner = outcome.get("winner_team_id") if outcome else None
    if winner is not None and home_team_id:
        home_won = str(winner) == str(home_team_id)

    row = DatasetRow(
        game_pk=game_pk,
        date_ymd=run.get("date_ymd") or "",
        model_id=run.get("model_id") or "heuristic_v1",
        run_id=run.get("run_id") or "",
        as_of_utc=run.get("as_of_utc"),
        first_pitch_utc=run.get("first_pitch_utc"),
        information_state=run.get("information_state") or "unknown",
        promotion_eligible=bool(run.get("promotion_eligible")),
        raw_home_probability=run.get("raw_home_probability"),
        raw_away_probability=run.get("raw_away_probability"),
        calibrated_home_probability=run.get("calibrated_home_probability"),
        calibrated_away_probability=run.get("calibrated_away_probability"),
        pick_side=run.get("pick_side"),
        pick_team_id=run.get("pick_team_id"),
        winner_team_id=str(winner) if winner else None,
        home_won=home_won,
        home_team_id=home_team_id,
        away_team_id=away_team_id,
        market_no_vig_home_prob=quote.get("home_no_vig_prob") if quote else None,
        market_no_vig_away_prob=quote.get("away_no_vig_prob") if quote else None,
        paired_quote_pair_id=quote.get("quote_pair_id") if quote else None,
        snapshot_hash=run.get("snapshot_hash"),
        feature_vector_hash=run.get("feature_hash"),
        feature_vector=_parse_feature_vector(run.get("normalized_feature_vector")),
    )
    return row, reason


def _load_runs(db_path: str, model_id: str | None = None) -> dict[str, list[dict[str, Any]]]:
    """Load prediction runs joined with model_predictions, grouped by game_pk."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        where = "WHERE mp.model_id = ?" if model_id else ""
        params = (model_id,) if model_id else ()
        rows = conn.execute(
            f"""
            SELECT pr.run_id, pr.game_pk, pr.date_ymd, pr.as_of_utc, pr.first_pitch_utc,
                   pr.prediction_timestamp_utc, pr.producer_timestamp_utc,
                   pr.model_id, pr.model_impl_version, pr.feature_schema_version,
                   pr.information_state, pr.prediction_quality_status,
                   pr.feature_hash, pr.snapshot_hash, pr.paired_quote_pair_id,
                   pr.normalized_feature_vector, pr.feature_manifest_version,
                   pr.core_inputs_hash,
                   mp.model_id AS mp_model_id, mp.raw_home_probability,
                   mp.raw_away_probability, mp.calibrated_home_probability,
                   mp.calibrated_away_probability, mp.pick_side, mp.pick_team_id,
                   mp.promotion_eligible, mp.market_no_vig_home_prob,
                   mp.market_no_vig_away_prob, mp.paired_quote_pair_id AS mp_quote_id
            FROM prediction_runs pr
            LEFT JOIN model_predictions mp ON mp.run_id = pr.run_id
            {where}
            ORDER BY pr.game_pk, pr.as_of_utc
            """,
            params,
        ).fetchall()
    finally:
        conn.close()

    by_game: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        d = dict(r)
        # Use the model_predictions row's model_id if joined; else run's.
        d["model_id"] = d.get("mp_model_id") or d.get("model_id") or "heuristic_v1"
        by_game.setdefault(str(d["game_pk"]), []).append(d)
    return by_game


def _load_outcomes(db_path: str) -> dict[str, dict[str, Any]]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT game_pk, date_ymd, home_team_id, away_team_id, home_score, "
            "away_score, winner_team_id, loser_team_id FROM game_outcomes"
        ).fetchall()
    finally:
        conn.close()
    return {str(r["game_pk"]): dict(r) for r in rows}


def _load_quotes(db_path: str) -> dict[str, dict[str, dict[str, Any]]]:
    """Load eligible quote pairs, indexed [game_pk][as_of_utc] -> latest pair."""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT quote_pair_id, game_pk, bookmaker, market, home_no_vig_prob, "
            "away_no_vig_prob, fetched_at_utc, is_opening, is_closing "
            "FROM market_quote_pairs WHERE is_eligible = 1"
        ).fetchall()
    finally:
        conn.close()

    by_game: dict[str, dict[str, dict[str, Any]]] = {}
    for r in rows:
        d = dict(r)
        game = str(d["game_pk"])
        by_game.setdefault(game, {})
        # Keep latest fetched_at <= a given as_of. Store by fetched_at for lookup.
        by_game[game][d["fetched_at_utc"] or ""] = d
    return by_game


def _pair_quote_for_run(
    quotes_by_game: dict[str, dict[str, dict[str, Any]]], game_pk: str, as_of_utc: str | None
) -> dict[str, Any] | None:
    if not game_pk or not as_of_utc:
        return None
    pairs = quotes_by_game.get(game_pk, {})
    # Latest pair with fetched_at <= as_of.
    eligible = [(ts, p) for ts, p in pairs.items() if ts and ts <= as_of_utc]
    if not eligible:
        return None
    eligible.sort(key=lambda x: x[0])
    return eligible[-1][1]


def build_game_dataset(
    db_path: str,
    model_id: str = "heuristic_v1",
    cohort: str = "main",
) -> tuple[list[DatasetRow], list[DatasetRow]]:
    """Build the all-game dataset for a model + cohort.

    Returns (clean_rows, quarantined_rows). Clean rows are promotion-eligible
    pregame predictions with valid outcomes. Quarantined rows carry a reason.
    """
    runs_by_game = _load_runs(db_path, model_id=model_id)
    outcomes = _load_outcomes(db_path)
    quotes_raw = _load_quotes(db_path)

    clean: list[DatasetRow] = []
    quarantined: list[DatasetRow] = []
    for game_pk, runs in runs_by_game.items():
        # Restrict runs to cohort information state.
        if cohort == "close_time":
            runs = [r for r in runs if r.get("information_state") == "close_time"]
        elif cohort == "confirmed_lineup":
            runs = [r for r in runs if r.get("information_state") == "confirmed_lineup"]
        if not runs:
            continue

        # Build a quote lookup that resolves per-run as_of.
        quotes_by_game = {
            game_pk: {
                ts: _pair_quote_for_run({game_pk: quotes_raw.get(game_pk, {})}, game_pk, ts)
                for ts in (r.get("as_of_utc") for r in runs)
                if ts
            }
        }
        # Simpler: resolve quote directly per selected run below.

        row, reason = select_main_cohort_row(runs, outcomes, quotes_raw)
        if row is None:
            continue
        # Attach resolved quote for this run's as_of.
        q = _pair_quote_for_run(quotes_raw, game_pk, row.as_of_utc)
        if q:
            row.market_no_vig_home_prob = q.get("home_no_vig_prob")
            row.market_no_vig_away_prob = q.get("away_no_vig_prob")
            row.paired_quote_pair_id = q.get("quote_pair_id")

        # Clean invariant: valid temporal row AND valid outcome AND
        # promotion eligibility AND no quarantine reason.
        if reason is None and row.home_won is not None and row.promotion_eligible:
            clean.append(row)
        else:
            if reason is None and not row.promotion_eligible:
                reason = "not_promotion_eligible"
            row.quarantine_reason = reason or (row.quarantine_reason or "unknown")
            quarantined.append(row)

    clean.sort(key=lambda r: (r.date_ymd, r.game_pk))
    return clean, quarantined


def build_folds(
    rows: list[DatasetRow],
    step_days: int = MIN_FOLD_STEP_DAYS,
    holdout_fraction: float = HOLDOUT_FRACTION,
) -> tuple[list[dict[str, Any]], str]:
    """Build chronological walk-forward folds + untouched holdout.

    Same-date games stay together. Last contiguous block is the holdout
    (holdout_fraction of dates). Returns (folds, dataset_hash).
    """
    if not rows:
        return [], _hash_rows([])

    dates = sorted({r.date_ymd for r in rows if r.date_ymd})
    if len(dates) < 2:
        return [], _hash_rows(rows)

    start = dates[0]
    end = dates[-1]
    holdout_count = max(1, int(len(dates) * holdout_fraction))
    holdout_start_idx = len(dates) - holdout_count
    holdout_start = dates[holdout_start_idx] if holdout_start_idx < len(dates) else end

    # Train+test folds only cover the pre-holdout range.
    fold_tuples = generate_walk_forward_dates(start, holdout_start, step_days=step_days)

    folds: list[dict[str, Any]] = []
    fold_index = 0
    for train_start, train_end, test_start, test_end in fold_tuples:
        # Clamp test window to the pre-holdout range so no test fold overlaps
        # the untouched holdout. Drop folds that start on/after holdout_start.
        if test_start >= holdout_start:
            continue
        clamped_end = min(test_end, holdout_start)
        test_rows = [r for r in rows if test_start <= r.date_ymd < clamped_end]
        train_rows = [r for r in rows if train_start <= r.date_ymd <= train_end]
        test_dates = sorted({r.date_ymd for r in test_rows})
        folds.append({
            "fold_index": fold_index,
            "fold_type": "test",
            "start_date": test_start,
            "end_date": clamped_end,
            "train_start_date": train_start,
            "train_end_date": train_end,
            "game_count": len(test_rows),
            "date_count": len(test_dates),
            "train_game_count": len(train_rows),
        })
        fold_index += 1

    holdout_rows = [r for r in rows if r.date_ymd >= holdout_start]
    folds.append({
        "fold_index": fold_index,
        "fold_type": "holdout",
        "start_date": holdout_start,
        "end_date": end,
        "train_start_date": start,
        "train_end_date": (folds[-1]["end_date"] if folds else holdout_start),
        "game_count": len(holdout_rows),
        "date_count": len({r.date_ymd for r in holdout_rows}),
        "train_game_count": len([r for r in rows if r.date_ymd < holdout_start]),
    })

    dataset_hash = _hash_rows(rows)
    return folds, dataset_hash


def _hash_rows(rows: list[DatasetRow]) -> str:
    payload = json.dumps([r.to_dict() for r in rows], sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()


def write_dataset_manifest(
    rows: list[DatasetRow],
    quarantined: list[DatasetRow],
    folds: list[dict[str, Any]],
    dataset_hash: str,
    output_dir: str,
    model_id: str = "heuristic_v1",
    cohort: str = "main",
) -> str:
    """Write JSONL dataset + CSV + manifest. Returns manifest path."""
    os.makedirs(output_dir, exist_ok=True)

    jsonl_path = os.path.join(output_dir, f"dataset_{model_id}_{cohort}.jsonl")
    with open(jsonl_path, "w") as f:
        for r in rows:
            f.write(json.dumps(r.to_dict(), default=str) + "\n")

    csv_path = os.path.join(output_dir, f"dataset_{model_id}_{cohort}.csv")
    if rows:
        keys = list(rows[0].to_dict().keys())
        with open(csv_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=keys)
            writer.writeheader()
            for r in rows:
                writer.writerow(r.to_dict())

    quarantine_path = os.path.join(output_dir, f"quarantine_{model_id}_{cohort}.jsonl")
    with open(quarantine_path, "w") as f:
        for r in quarantined:
            f.write(json.dumps(r.to_dict(), default=str) + "\n")

    manifest = {
        "manifest_version": MANIFEST_VERSION,
        "model_id": model_id,
        "cohort": cohort,
        "dataset_hash": dataset_hash,
        "row_count": len(rows),
        "quarantine_count": len(quarantined),
        "quarantine_reasons": _quarantine_summary(quarantined),
        "folds": folds,
        "fold_count": len(folds),
        "holdout_present": any(f["fold_type"] == "holdout" for f in folds),
        "date_range": {
            "start": min((r.date_ymd for r in rows), default=None),
            "end": max((r.date_ymd for r in rows), default=None),
        },
        "created_at": datetime.utcnow().isoformat() + "Z",
        "files": {
            "jsonl": os.path.basename(jsonl_path),
            "csv": os.path.basename(csv_path),
            "quarantine": os.path.basename(quarantine_path),
        },
    }
    manifest_path = os.path.join(output_dir, "dataset_manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2, default=str)
    return manifest_path


def _quarantine_summary(rows: list[DatasetRow]) -> dict[str, int]:
    summary: dict[str, int] = {}
    for r in rows:
        reason = r.quarantine_reason or "unknown"
        summary[reason] = summary.get(reason, 0) + 1
    return summary
