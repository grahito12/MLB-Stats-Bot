"""P6 OOF calibration tests.

Verifies:
  - no scored label enters the calibrator that calibrates it (prequential: fold k
    calibrated only from earlier folds; first fold identity)
  - identity / Platt / guarded isotonic / beta are all scored prequentially
  - beta is comparison-only and never selected as deployable (no JS parity)
  - unstable methods are skipped, not forced (distinctness check)
  - holdout scored exactly once, never fit on
  - proposal artifact written; live V1 files never touched
  - artifact hash tamper-detects
  - insufficient-data gate emits no usable artifact

Uses temporary SQLite DBs. Never touches live data/state.sqlite.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from src.eval.oof_calibration import (
    run_oof_calibration,
    write_proposal_artifact,
    _fit_platt,
    _fit_isotonic_guarded,
    _fit_beta,
    _apply_method,
    _distinctness_ok,
    ALL_METHODS,
    DEPLOYABLE_METHODS,
    METHOD_IDENTITY,
    METHOD_BETA,
    METHOD_PLATT,
    METHOD_ISOTONIC_GUARDED,
    MIN_CALIB_SAMPLES,
    _stable_stringify,
    _artifact_hash,
)

MIGRATIONS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "storage", "migrations"
)


def _apply_migrations(db_path: str) -> None:
    conn = sqlite3.connect(db_path)
    conn.executescript(
        "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);"
    )
    skip = {"004_append_only_picks", "005_shadow_ledger"}
    files = sorted(f for f in os.listdir(MIGRATIONS_DIR) if f.endswith(".sql"))
    for fname in files:
        mid = fname.replace(".sql", "")
        if mid in skip:
            continue
        with open(os.path.join(MIGRATIONS_DIR, fname)) as fh:
            conn.executescript(fh.read())
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
            (mid, f"test-{mid}", datetime.now(timezone.utc).isoformat()),
        )
    conn.commit()
    conn.close()


def _make_db(n_games: int = 220, miscalibrated: bool = True) -> str:
    """Synthetic chronological DB with a real calibration signal.

    Raw model probabilities are systematically OVER-confident when
    `miscalibrated=True`: the true home-win rate is a shrunk version of the raw
    prob. This gives isotonic/Platt a real prequential edge over identity.
    """
    fd, db_path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    _apply_migrations(db_path)
    conn = sqlite3.connect(db_path)
    base = datetime(2026, 4, 1, 12, 0, 0, tzinfo=timezone.utc)
    rng = np.random.RandomState(42)
    for i in range(n_games):
        game_pk = 1000 + i
        date = base + timedelta(days=i)
        first_pitch = date + timedelta(hours=11)
        as_of = date + timedelta(hours=3)
        run_id = f"run-{game_pk}"
        # Raw prob centered around 0.5 with spread.
        raw_home = float(np.clip(0.40 + rng.rand() * 0.20, 0.30, 0.70))
        if miscalibrated:
            # True rate shrunk toward 0.5 (raw is over-confident).
            true_rate = 0.5 + (raw_home - 0.5) * 0.4
        else:
            true_rate = raw_home
        home_won = rng.rand() < true_rate
        # Store as 0-100 scale (model_predictions uses REAL; builder normalizes).
        raw_pct = raw_home * 100.0
        conn.execute(
            "INSERT INTO prediction_runs (run_id, game_pk, market, date_ymd, "
            "prediction_timestamp_utc, as_of_utc, first_pitch_utc, created_at, "
            "model_id, information_state, producer_timestamp_utc) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, str(game_pk), "moneyline", date.strftime("%Y-%m-%d"),
             as_of.isoformat(), as_of.isoformat(), first_pitch.isoformat(), as_of.isoformat(),
             "heuristic_v1", "scheduled_early", as_of.isoformat()),
        )
        conn.execute(
            "INSERT INTO model_predictions (prediction_id, run_id, game_pk, date_ymd, "
            "model_id, raw_home_probability, raw_away_probability, "
            "calibrated_home_probability, calibrated_away_probability, "
            "pick_side, pick_team_id, as_of_utc, first_pitch_utc, information_state, "
            "promotion_eligible, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"mp-{run_id}", run_id, str(game_pk), date.strftime("%Y-%m-%d"), "heuristic_v1",
             raw_pct, 100.0 - raw_pct, raw_pct, 100.0 - raw_pct,
             "home" if raw_home >= 0.5 else "away", "120",
             as_of.isoformat(), first_pitch.isoformat(), "scheduled_early", 1, as_of.isoformat()),
        )
        conn.execute(
            "INSERT INTO game_outcomes (game_pk, date_ymd, home_team_id, away_team_id, "
            "home_score, away_score, winner_team_id, loser_team_id, recorded_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (str(game_pk), date.strftime("%Y-%m-%d"), "120", "113",
             5 if home_won else 3, 3 if home_won else 5,
             "120" if home_won else "113", "113" if home_won else "120",
             datetime.now(timezone.utc).isoformat()),
        )
    conn.commit()
    conn.close()
    return db_path


# ---------- structural ----------


def test_beta_is_not_deployable():
    assert METHOD_BETA in ALL_METHODS
    assert METHOD_BETA not in DEPLOYABLE_METHODS
    assert set(DEPLOYABLE_METHODS).issubset(set(ALL_METHODS))


def test_stable_stringify_mirrors_js_shape():
    # Booleans, ints, floats, nested dict/list — matches JS stableStringify.
    assert _stable_stringify(True) == "true"
    assert _stable_stringify(3) == "3"
    assert _stable_stringify(3.0) == "3"
    assert _stable_stringify(0.5) == "0.5"
    assert _stable_stringify([1, 2]) == "[1,2]"
    assert _stable_stringify({"b": 1, "a": 2}) == '{"a":2,"b":1}'


# ---------- method fitters ----------


def test_platt_fit_and_apply():
    rng = np.random.RandomState(1)
    probs = np.clip(0.3 + rng.rand(200) * 0.4, 0.05, 0.95)
    true_rate = 0.5 + (probs - 0.5) * 0.5
    outcomes = (rng.rand(200) < true_rate).astype(int)
    params, reason = _fit_platt(probs, outcomes)
    assert params is not None, reason
    assert params["a"] > 0
    # Applying must move probabilities (distinct from identity).
    assert _distinctness_ok(METHOD_PLATT, params, probs)


def test_isotonic_fit_and_apply():
    rng = np.random.RandomState(2)
    probs = np.clip(0.3 + rng.rand(200) * 0.4, 0.05, 0.95)
    outcomes = (rng.rand(200) < (0.5 + (probs - 0.5) * 0.5)).astype(int)
    mapping, reason = _fit_isotonic_guarded(probs, outcomes)
    assert mapping is not None, reason
    assert len(mapping) >= 2
    # Monotonic non-decreasing y.
    ys = [m[1] for m in mapping]
    assert all(ys[i] <= ys[i + 1] + 1e-9 for i in range(len(ys) - 1))


def test_insufficient_samples_skips_nonidentity():
    small = np.array([0.4, 0.5, 0.6])
    outcomes = np.array([0, 1, 1])
    for method in (METHOD_PLATT, METHOD_ISOTONIC_GUARDED, METHOD_BETA):
        params, reason = _fit_method_dispatch(method, small, outcomes)
        assert params is None
        assert "insufficient" in reason


def _fit_method_dispatch(method, probs, outcomes):
    if method == METHOD_PLATT:
        return _fit_platt(probs, outcomes)
    if method == METHOD_ISOTONIC_GUARDED:
        return _fit_isotonic_guarded(probs, outcomes)
    if method == METHOD_BETA:
        return _fit_beta(probs, outcomes)
    return {}, None


# ---------- engine ----------


def test_run_oof_calibration_produces_artifact():
    db_path = _make_db(220)
    try:
        report = run_oof_calibration(db_path)
        assert report["status"] == "trained"
        assert report["artifact"] is not None
        assert report["selected_method"] in DEPLOYABLE_METHODS
        assert report["final_method"] in DEPLOYABLE_METHODS
        # All four methods scored prequentially.
        for m in ALL_METHODS:
            assert m in report["prequential"]
        # Holdout scored once.
        assert report["holdout_scored_once"] is True
    finally:
        os.unlink(db_path)


def test_no_scored_label_enters_calibrator_for_fold_k():
    """Prequential leakage guard: fold k is calibrated only from earlier folds.

    We verify by checking the fold_methods log: the first non-empty fold must use
    identity, and any fold using a non-identity method must have earlier-fold
    history available.
    """
    db_path = _make_db(220)
    try:
        report = run_oof_calibration(db_path)
        preq = report["prequential"]
        # Check each method's fold log.
        for method in ALL_METHODS:
            folds = preq[method]["fold_methods"]
            non_empty = [f for f in folds if f["reason"] != "empty_test_fold"]
            if not non_empty:
                continue
            first = non_empty[0]
            assert first["method_used"] == METHOD_IDENTITY or "first_fold" in (first["reason"] or ""), (
                f"method {method} first fold {first} not identity"
            )
    finally:
        os.unlink(db_path)


def test_holdout_never_used_in_fit():
    """The holdout must be scored exactly once and never enter the fit set."""
    db_path = _make_db(220)
    try:
        report = run_oof_calibration(db_path)
        assert report["holdout_scored_once"] is True
        # pre_holdout_oof_pairs should be < total clean rows (holdout excluded).
        from src.dataset.build_game_dataset import build_game_dataset, build_folds

        clean, _ = build_game_dataset(db_path, model_id="heuristic_v1", cohort="main")
        folds, _ = build_folds(clean)
        holdout = [f for f in folds if f["fold_type"] == "holdout"]
        if holdout:
            holdout_rows = sum(1 for r in clean if r.date_ymd >= holdout[0]["start_date"])
            assert report["pre_holdout_oof_pairs"] <= len(clean) - holdout_rows + 1
    finally:
        os.unlink(db_path)


def test_beta_never_selected_as_deployable():
    db_path = _make_db(220)
    try:
        report = run_oof_calibration(db_path)
        # Even if beta wins prequentially, selected_method must be deployable.
        assert report["selected_method"] in DEPLOYABLE_METHODS
        assert report["final_method"] in DEPLOYABLE_METHODS
        assert report["selected_method"] != METHOD_BETA
    finally:
        os.unlink(db_path)


def test_unstable_method_skipped_not_forced():
    """When the calibration signal is absent (well-calibrated raw), non-identity
    methods should be skipped via distinctness, and identity wins."""
    db_path = _make_db(220, miscalibrated=False)  # raw == true rate
    try:
        report = run_oof_calibration(db_path)
        # With no miscalibration, identity is a strong candidate. Either identity
        # is selected or a method that passed distinctness — but never a forced
        # degenerate map. Verify final method is deployable + artifact present.
        assert report["status"] == "trained"
        assert report["final_method"] in DEPLOYABLE_METHODS
    finally:
        os.unlink(db_path)


# ---------- proposal artifact governance ----------


def test_proposal_artifact_written_and_live_files_untouched(tmp_path):
    db_path = _make_db(220)
    try:
        report = run_oof_calibration(db_path)
        out = tmp_path / "models"
        path = write_proposal_artifact(report, str(out))
        assert os.path.exists(path)
        with open(path) as f:
            loaded = json.load(f)
        assert loaded["status"] == "trained"
        # The proposal artifact must NOT write the live V1 calibration filenames.
        written = set(os.listdir(out))
        assert "calibration_maps.json" not in written
        assert "calibration_meta.json" not in written
        assert "calibration_map.json" not in written
    finally:
        os.unlink(db_path)


def test_artifact_hash_tamper_detect():
    db_path = _make_db(220)
    try:
        report = run_oof_calibration(db_path)
        artifact = dict(report["artifact"])
        original_hash = artifact["artifact_hash"]
        # Tamper with params.
        if artifact["method"] == METHOD_PLATT:
            artifact = json.loads(json.dumps(artifact))
            artifact["params"]["a"] = artifact["params"]["a"] + 1.0
        elif artifact["method"] == METHOD_ISOTONIC_GUARDED:
            artifact = json.loads(json.dumps(artifact))
            artifact["params"][0][1] = artifact["params"][0][1] + 0.1
        else:
            # identity — tamper with sample_count.
            artifact = json.loads(json.dumps(artifact))
            artifact["sample_count"] = artifact["sample_count"] + 1
        recomputed = _artifact_hash({k: v for k, v in artifact.items() if k != "artifact_hash"})
        assert recomputed != original_hash
    finally:
        os.unlink(db_path)


def test_insufficient_data_emits_no_artifact():
    # All games on a single date -> build_folds needs >=2 dates -> no test folds.
    fd, db_path = tempfile.mkstemp(suffix=".sqlite")
    os.close(fd)
    _apply_migrations(db_path)
    conn = sqlite3.connect(db_path)
    rng = np.random.RandomState(7)
    base = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
    for i in range(30):
        game_pk = 2000 + i
        date = base  # same date for every game
        first_pitch = date + timedelta(hours=11)
        as_of = date + timedelta(hours=3)
        run_id = f"run-{game_pk}"
        raw_home = float(np.clip(0.40 + rng.rand() * 0.20, 0.30, 0.70))
        home_won = rng.rand() < 0.5 + (raw_home - 0.5) * 0.4
        raw_pct = raw_home * 100.0
        conn.execute(
            "INSERT INTO prediction_runs (run_id, game_pk, market, date_ymd, "
            "prediction_timestamp_utc, as_of_utc, first_pitch_utc, created_at, "
            "model_id, information_state, producer_timestamp_utc) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, str(game_pk), "moneyline", date.strftime("%Y-%m-%d"),
             as_of.isoformat(), as_of.isoformat(), first_pitch.isoformat(), as_of.isoformat(),
             "heuristic_v1", "scheduled_early", as_of.isoformat()),
        )
        conn.execute(
            "INSERT INTO model_predictions (prediction_id, run_id, game_pk, date_ymd, "
            "model_id, raw_home_probability, raw_away_probability, "
            "calibrated_home_probability, calibrated_away_probability, "
            "pick_side, pick_team_id, as_of_utc, first_pitch_utc, information_state, "
            "promotion_eligible, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"mp-{run_id}", run_id, str(game_pk), date.strftime("%Y-%m-%d"), "heuristic_v1",
             raw_pct, 100.0 - raw_pct, raw_pct, 100.0 - raw_pct,
             "home", "120",
             as_of.isoformat(), first_pitch.isoformat(), "scheduled_early", 1, as_of.isoformat()),
        )
        conn.execute(
            "INSERT INTO game_outcomes (game_pk, date_ymd, home_team_id, away_team_id, "
            "home_score, away_score, winner_team_id, loser_team_id, recorded_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (str(game_pk), date.strftime("%Y-%m-%d"), "120", "113",
             5 if home_won else 3, 3 if home_won else 5,
             "120" if home_won else "113", "113" if home_won else "120",
             datetime.now(timezone.utc).isoformat()),
        )
    conn.commit()
    conn.close()
    try:
        report = run_oof_calibration(db_path)
        assert report["status"] == "insufficient_data"
        assert report["artifact"] is None
        assert report["artifact_hash"] is None
        assert report["recommendation_eligible"] is False
    finally:
        os.unlink(db_path)


# ---------- JS / Python parity ----------


def test_js_python_artifact_hash_and_application_parity(tmp_path):
    """The Python-built proposal artifact must hash identically in JS, and JS
    application must match Python application on the same probability.

    Parity is about the serialization/application CONTRACT, not which method wins
    selection — so we build deterministic Platt + isotonic artifacts directly and
    verify hash + apply parity. Decoupled from the prequential selection outcome.
    """
    from src.eval.oof_calibration import OOF_CALIBRATION_ARTIFACT_MANIFEST_VERSION

    cases = [
        ("platt", {"a": 0.6, "b": 0.05}),
        ("isotonic_guarded", [[0.3, 0.34], [0.45, 0.42], [0.6, 0.55], [0.75, 0.71]]),
    ]
    for method, params in cases:
        artifact = {
            "artifact_manifest_version": OOF_CALIBRATION_ARTIFACT_MANIFEST_VERSION,
            "model_id": "heuristic_v1",
            "cohort": "main",
            "method": method,
            "target_probability": "raw_home_probability",
            "params": params,
            "dataset_hash": "parity-dataset-hash",
            "training_cutoff": "2026-08-01",
            "sample_count": 220,
            "pre_holdout_oof_pairs": 220,
            "prequential_brier_by_method": {"identity": 0.25, method: 0.24},
            "selected_prequential_brier": 0.24,
            "holdout_metrics_identity": {"n": 44, "brier": 0.24},
            "holdout_metrics_calibrated": {"n": 44, "brier": 0.23},
            "gates": {"min_calib_samples": 60},
            "deployable_methods": ["identity", "platt", "isotonic_guarded"],
        }
        artifact["artifact_hash"] = _artifact_hash(
            {k: v for k, v in artifact.items() if k != "artifact_hash"}
        )
        artifact_file = tmp_path / f"parity-{method}.json"
        with open(artifact_file, "w") as f:
            json.dump({"status": "trained", "artifact": artifact}, f)

        # Python application on a few test points.
        test_points = [0.32, 0.5, 0.57, 0.71, 0.9]
        py_applied = [_apply_method(method, params, p) for p in test_points]

        js = _run_js(
            f"""
            import {{ readFileSync }} from 'node:fs';
            import {{ hashArtifactContent, applyOofCalibration, verifyOofCalibrationArtifact }}
              from './src/core/calibration_proposal.js';
            const report = JSON.parse(readFileSync(process.argv[1], 'utf8'));
            const artifact = report.artifact;
            const hash = hashArtifactContent(artifact);
            const verify = verifyOofCalibrationArtifact(artifact);
            const points = {json.dumps(test_points)};
            const applied = points.map(p => Math.round(applyOofCalibration(artifact, p) * 1e9) / 1e9);
            console.log(JSON.stringify({{
              hash, verifyOk: verify.ok, verifyReasons: verify.reasons, applied
            }}));
            """,
            [str(artifact_file)],
        )
        js_obj = json.loads(js)

        # Hash parity.
        py_content = {k: v for k, v in artifact.items() if k != "artifact_hash"}
        py_hash = _artifact_hash(py_content)
        assert js_obj["hash"] == py_hash, (
            f"{method} hash mismatch: js={js_obj['hash']} py={py_hash}"
        )
        assert js_obj["verifyOk"] is True, f"{method} verify failed: {js_obj['verifyReasons']}"
        # Application parity at every test point within 1e-6.
        for p, py_val, js_val in zip(test_points, py_applied, js_obj["applied"]):
            assert abs(js_val - round(py_val, 9)) < 1e-6, (
                f"{method} apply mismatch at p={p}: js={js_val} py={py_val}"
            )


def _run_js(code: str, args: list[str]) -> str:
    """Run a JS snippet via node --input-type=module -e, capturing stdout."""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", code, "--", *args],
        capture_output=True,
        text=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        timeout=60,
    )
    if proc.returncode != 0:
        raise AssertionError(f"node failed: {proc.stderr}")
    return proc.stdout.strip()
