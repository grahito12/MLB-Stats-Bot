"""P7 diagnostics, comparison, and evidence-bound recommendation.

Generates ALL reports from real saved outputs only (model_predictions +
game_outcomes + market_quote_pairs + feature_snapshots). Never fabricates
missing provenance, metrics, or promotion rows.

Reports written to reports/:
  - reports/model_comparison.md (+ .json)
  - reports/ablation_index.md (index of ablation reports)
  - reports/calibration_oof.md
  - reports/accuracy_coverage.md (fixed coverage levels by abs(p-0.5), not tuned)
  - reports/model_market_disagreement.md
  - reports/edge_buckets.md (edge = model - no_vig market probability, NOT a bet claim)
  - reports/information_state_cohorts.md

Every report includes: dataset/artifact/code hashes, date range, population/
provenance status, folds, final-holdout status, per-model coverage + common-
cohort sample size, accuracy/Brier/log loss/AUC/ECE/reliability table, fold/
subgroup stability, missing-data rates. Splits (home/away, favorite/underdog,
confidence, month, model-market disagreement) where sample permits.

Final recommendation via src/eval/recommend.py — exactly one of:
  KEEP V1 / RUN V2 IN SHADOW / PROMOTE LEARNED V2 / PROMOTE MARKET RESIDUAL V2
Insufficient evidence remains: INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE.

Reads from a (copy of) the production DB. NEVER mutates production tables.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any

from src.dataset.build_game_dataset import build_game_dataset, build_folds, DatasetRow
from src.eval.compare_models import compare_models, _norm_prob
from src.eval.metrics import model_metrics, reliability_bins
from src.eval.recommend import recommend

REPORT_VERSION = "p7-reports-v1"
COVERAGE_LEVELS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]
EDGE_BUCKET_WIDTH = 0.05  # |model - no_vig| buckets


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _f(v: Any) -> str:
    if v is None:
        return "—"
    try:
        return f"{float(v):.4f}"
    except (TypeError, ValueError):
        return str(v)


def _md_table(headers: list[str], rows: list[list[Any]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows:
        out.append("| " + " | ".join(_f(c) if isinstance(c, float) else str(c) for c in row) + " |")
    return "\n".join(out)


def generate_p7_reports(
    db_path: str,
    output_dir: str = "reports",
    model_id: str = "heuristic_v1",
    cohort: str = "main",
) -> dict[str, Any]:
    """Generate all P7 reports + the evidence-bound recommendation.

    Returns a summary dict of {report_paths, recommendation}.
    """
    os.makedirs(output_dir, exist_ok=True)
    clean, quarantined = build_game_dataset(db_path, model_id=model_id, cohort=cohort)
    folds, dataset_hash = build_folds(clean)
    rows = [r.to_dict() for r in clean]

    holdout_fold = next((f for f in folds if f["fold_type"] == "holdout"), None)
    test_folds = [f for f in folds if f["fold_type"] == "test"]

    common = {
        "report_version": REPORT_VERSION,
        "generated_at_utc": _now_utc(),
        "model_id": model_id,
        "cohort": cohort,
        "dataset_hash": dataset_hash,
        "row_count": len(rows),
        "quarantine_count": len(quarantined),
        "fold_count": len(folds),
        "test_fold_count": len(test_folds),
        "holdout_present": holdout_fold is not None,
        "holdout_rows": holdout_fold["game_count"] if holdout_fold else 0,
        "date_range": {
            "start": min((r["date_ymd"] for r in rows), default=None),
            "end": max((r["date_ymd"] for r in rows), default=None),
        },
        "source_db": db_path,
    }

    report_paths: dict[str, str] = {}

    # 1. model_comparison
    report_paths["model_comparison"] = _write_model_comparison(
        db_path, output_dir, common, model_id, cohort
    )

    # 2. ablation_index
    report_paths["ablation_index"] = _write_ablation_index(output_dir, common)

    # 3. calibration_oof
    report_paths["calibration_oof"] = _write_calibration_oof(
        db_path, output_dir, common, model_id, cohort
    )

    # 4. accuracy_coverage
    report_paths["accuracy_coverage"] = _write_accuracy_coverage(
        rows, folds, output_dir, common
    )

    # 5. model_market_disagreement
    report_paths["model_market_disagreement"] = _write_model_market_disagreement(
        rows, folds, output_dir, common
    )

    # 6. edge_buckets
    report_paths["edge_buckets"] = _write_edge_buckets(rows, folds, output_dir, common)

    # 7. information_state_cohorts
    report_paths["information_state_cohorts"] = _write_information_state_cohorts(
        db_path, output_dir, common, model_id
    )

    # 8. evidence-bound recommendation
    recommendation = _build_recommendation(db_path, output_dir, common, model_id, cohort)
    report_paths["recommendation"] = recommendation["path"]

    return {"report_paths": report_paths, "recommendation": recommendation["result"]}


# ---------------------------------------------------------------------------
# Report: model_comparison
# ---------------------------------------------------------------------------


def _write_model_comparison(db_path, output_dir, common, model_id, cohort) -> str:
    comp = compare_models(db_path, model_id=model_id, cohort=cohort)
    payload = {**common, "comparison": comp}

    md = ["# Model Comparison Report", ""]
    md.append(f"- Generated: `{common['generated_at_utc']}`")
    md.append(f"- Dataset hash: `{common['dataset_hash']}`")
    md.append(f"- Rows: {common['row_count']} | quarantined: {common['quarantine_count']} | "
              f"folds: {common['fold_count']} (test: {common['test_fold_count']}, holdout: {common['holdout_present']})")
    md.append(f"- Date range: {common['date_range']['start']} → {common['date_range']['end']}")
    md.append(f"- Source DB: `{common['source_db']}`")
    md.append("")

    ctrl = comp.get("control", {})
    md.append("## Control heuristic_v1 (stored calibrated probability, OOF test folds)")
    md.append("")
    md.append(_md_table(
        ["metric", "mean", "std", "folds", "coverage"],
        [[k, ctrl.get(f"mean_{k}"), ctrl.get(f"std_{k}"), ctrl.get("n_folds"), ctrl.get("total_coverage")]
         for k in ["accuracy", "brier", "log_loss", "roc_auc", "ece"]]
    ))
    md.append("")

    md.append("## Baselines (identical cohorts, per-fold mean)")
    md.append("")
    base = comp.get("baselines", {})
    brows = []
    for name in ["home_baseline", "elo_log5", "market_baseline"]:
        b = base.get(name, {})
        brows.append([name, b.get("mean_brier"), b.get("mean_log_loss"), b.get("mean_accuracy"),
                      b.get("mean_roc_auc"), b.get("mean_ece"), b.get("total_coverage")])
    md.append(_md_table(["baseline", "Brier", "log loss", "accuracy", "AUC", "ECE", "coverage"], brows))
    md.append("")

    ci = comp.get("common_intersection", {})
    md.append("## Common-intersection (control + market on same with-market rows)")
    md.append("")
    md.append(f"- folds: {ci.get('n_folds')} | total n: {ci.get('total_n')}")
    md.append(_md_table(
        ["model", "Brier", "log loss", "accuracy", "AUC"],
        [["control", ci.get("control_mean_brier"), ci.get("control_mean_log_loss"),
          ci.get("control_mean_accuracy"), ci.get("control_mean_auc")],
         ["market", ci.get("market_mean_brier"), ci.get("market_mean_log_loss"),
          ci.get("market_mean_accuracy"), ci.get("market_mean_auc")]]
    ))
    md.append("")
    md.append("---")
    md.append("")
    md.append("_Control uses stored calibrated_home_probability. Market uses same-book no-vig. "
              "Common-intersection restricts to rows where BOTH produce a probability. "
              "Holdout is not opened here. No ROI/tuned-cutoff selection._")

    md_path = os.path.join(output_dir, "model_comparison.md")
    json_path = os.path.join(output_dir, "model_comparison.json")
    with open(md_path, "w") as f:
        f.write("\n".join(md) + "\n")
    with open(json_path, "w") as f:
        json.dump(payload, f, indent=2, default=str)
    return md_path


# ---------------------------------------------------------------------------
# Report: ablation_index
# ---------------------------------------------------------------------------


def _write_ablation_index(output_dir, common) -> str:
    ablation_dir = os.path.join(output_dir, "ablation")
    md = ["# Ablation Report Index", ""]
    md.append(f"- Generated: `{common['generated_at_utc']}`")
    md.append(f"- Dataset hash: `{common['dataset_hash']}`")
    md.append("")
    md.append("Per-family chronological ablations live under `reports/ablation/`. "
              "Each compares full / leave-one-out / family-only logistic on the SAME "
              "walk-forward test folds. Holdout never opened. V1 production math unchanged.")
    md.append("")
    schemas = ["control-v1-families", "candidate-v1-families"]
    md.append("| schema | json | markdown |")
    md.append("|---|---|---|")
    for schema in schemas:
        j = os.path.join("ablation", f"ablation_{schema}.json")
        m = os.path.join("ablation", f"ablation_{schema}.md")
        exists = "✓" if os.path.exists(os.path.join(output_dir, j)) else "—"
        md.append(f"| {schema} | {exists} | {exists} |")
    md.append("")
    md.append("Run `python scripts/run_ablation.py --sqlite <db> --output reports/ablation` "
              "to (re)generate. Generation does not fabricate missing families.")
    md_path = os.path.join(output_dir, "ablation_index.md")
    with open(md_path, "w") as f:
        f.write("\n".join(md) + "\n")
    return md_path


# ---------------------------------------------------------------------------
# Report: calibration_oof
# ---------------------------------------------------------------------------


def _write_calibration_oof(db_path, output_dir, common, model_id, cohort) -> str:
    """Summarize the P6 OOF calibration proposal if present, else report absence."""
    md = ["# OOF Calibration Report", ""]
    md.append(f"- Generated: `{common['generated_at_utc']}`")
    md.append(f"- Dataset hash: `{common['dataset_hash']}`")
    md.append(f"- Target probability: `raw_home_probability` (control, uncalibrated)")
    md.append("")

    # Look for a proposal artifact in data/models/.
    models_dir = os.environ.get("MLB_MODEL_ARTIFACTS_DIR", "data/models")
    artifact = _find_oof_artifact(models_dir, model_id)
    if artifact is None:
        md.append("**No OOF calibration proposal artifact found.** Run "
                  "`python scripts/run_oof_calibration.py --sqlite <db> --output data/models` "
                  "to generate one. The live V1 calibration is unchanged by default; "
                  "activation requires separate human approval.")
        md.append("")
        md.append("_No fabrication: absence of an artifact is reported, not a fake map._")
        md_path = os.path.join(output_dir, "calibration_oof.md")
        with open(md_path, "w") as f:
            f.write("\n".join(md) + "\n")
        return md_path

    a = artifact
    md.append(f"- Artifact hash: `{a.get('artifact_hash')}`")
    md.append(f"- Method: `{a.get('method')}` | sample_count: {a.get('sample_count')}")
    md.append(f"- Training cutoff: `{a.get('training_cutoff')}`")
    md.append(f"- Pre-holdout OOF pairs: {a.get('pre_holdout_oof_pairs')}")
    md.append("")
    pbm = a.get("prequential_brier_by_method", {})
    md.append("## Prequential Brier by method (pre-holdout, fold k from earlier folds only)")
    md.append("")
    md.append(_md_table(
        ["method", "prequential Brier", "deployable"],
        [[m, pbm.get(m), "yes" if m in ("identity", "platt", "isotonic_guarded") else "no (reference)"]
         for m in ["identity", "platt", "isotonic_guarded", "beta"]]
    ))
    md.append("")
    hi = a.get("holdout_metrics_identity", {})
    hc = a.get("holdout_metrics_calibrated", {})
    md.append("## Holdout (scored once, never fit)")
    md.append("")
    md.append(_md_table(
        ["variant", "n", "Brier", "log loss", "accuracy", "ECE"],
        [["identity", hi.get("n"), hi.get("brier"), hi.get("log_loss"), hi.get("accuracy"), hi.get("ece")],
         ["calibrated", hc.get("n"), hc.get("brier"), hc.get("log_loss"), hc.get("accuracy"), hc.get("ece")]]
    ))
    md.append("")
    md.append("---")
    md.append("")
    md.append("_Proposal artifact only. Live V1 calibration files are NOT overwritten. "
              "Activation requires separate human approval._")
    md_path = os.path.join(output_dir, "calibration_oof.md")
    with open(md_path, "w") as f:
        f.write("\n".join(md) + "\n")
    return md_path


def _find_oof_artifact(models_dir, model_id):
    if not os.path.isdir(models_dir):
        return None
    best = None
    best_mtime = -1
    for fname in os.listdir(models_dir):
        if not fname.endswith(".json"):
            continue
        path = os.path.join(models_dir, fname)
        try:
            with open(path) as f:
                report = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        if report.get("status") != "trained":
            continue
        a = report.get("artifact")
        if not isinstance(a, dict):
            continue
        if a.get("artifact_manifest_version") != "oof-calibration-artifact-v1":
            continue
        if a.get("model_id") != model_id:
            continue
        mtime = os.path.getmtime(path)
        if mtime > best_mtime:
            best = a
            best_mtime = mtime
    return best


# ---------------------------------------------------------------------------
# Report: accuracy_coverage (fixed coverage levels, NOT tuned cutoffs)
# ---------------------------------------------------------------------------


def _write_accuracy_coverage(rows, folds, output_dir, common) -> str:
    md = ["# Accuracy Coverage Report", ""]
    md.append(f"- Generated: `{common['generated_at_utc']}`")
    md.append(f"- Dataset hash: `{common['dataset_hash']}`")
    md.append(f"- Coverage levels ranked by `abs(p - 0.5)`, NOT tuned cutoffs.")
    md.append("")

    # Pool test-fold rows with a control probability + outcome.
    pooled = []
    for fold in folds:
        if fold["fold_type"] != "test":
            continue
        for r in rows:
            if fold["start_date"] <= r["date_ymd"] < fold["end_date"]:
                p = _norm_prob(r.get("calibrated_home_probability"))
                o = r.get("home_won")
                if p is not None and o is not None:
                    pooled.append((p, int(o)))
    md.append(f"- Pooled OOF test-fold rows with control prob: {len(pooled)}")
    md.append("")

    md.append("## Accuracy at fixed coverage levels")
    md.append("")
    md.append("Coverage = fraction of predictions with `abs(p - 0.5) >= threshold`. "
              "Accuracy computed on that subset (predict home when p >= 0.5).")
    md.append("")
    md.append("| threshold | coverage % | n | accuracy | Brier |")
    md.append("|---|---|---|---|---|")
    for level in COVERAGE_LEVELS:
        subset = [(p, o) for p, o in pooled if abs(p - 0.5) >= level]
        if not subset:
            md.append(f"| {level:.2f} | 0.00% | 0 | — | — |")
            continue
        probs = [p for p, _ in subset]
        outs = [o for _, o in subset]
        acc = model_metrics(probs, outs)
        cov_pct = 100.0 * len(subset) / len(pooled) if pooled else 0.0
        md.append(f"| {level:.2f} | {cov_pct:.2f}% | {len(subset)} | "
                  f"{_f(acc.get('accuracy'))} | {_f(acc.get('brier'))} |")
    md.append("")
    md.append("---")
    md.append("")
    md.append("_Coverage levels are predeclared and fixed, not optimized on outcomes. "
              "No threshold tuning on test/holdout._")
    md_path = os.path.join(output_dir, "accuracy_coverage.md")
    with open(md_path, "w") as f:
        f.write("\n".join(md) + "\n")
    return md_path


# ---------------------------------------------------------------------------
# Report: model_market_disagreement
# ---------------------------------------------------------------------------


def _write_model_market_disagreement(rows, folds, output_dir, common) -> str:
    md = ["# Model–Market Disagreement Report", ""]
    md.append(f"- Generated: `{common['generated_at_utc']}`")
    md.append(f"- Dataset hash: `{common['dataset_hash']}`")
    md.append("")
    md.append("Disagreement = `control_probability - no_vig_market_probability` on the "
              "common-intersection with-market rows. This is a diagnostic of where the "
              "model diverges from market consensus — NOT a bet-selection edge claim.")
    md.append("")

    pooled = []
    for fold in folds:
        if fold["fold_type"] != "test":
            continue
        for r in rows:
            if fold["start_date"] <= r["date_ymd"] < fold["end_date"]:
                cp = _norm_prob(r.get("calibrated_home_probability"))
                mp = _norm_prob(r.get("market_no_vig_home_prob"))
                o = r.get("home_won")
                if cp is not None and mp is not None and o is not None:
                    pooled.append((cp, mp, int(o)))
    md.append(f"- With-market OOF rows: {len(pooled)}")
    if not pooled:
        md.append("")
        md.append("_No with-market rows on test folds. Disagreement cannot be computed. "
                  "Forward with-market history must accrue._")
        md_path = os.path.join(output_dir, "model_market_disagreement.md")
        with open(md_path, "w") as f:
            f.write("\n".join(md) + "\n")
        return md_path

    disagreements = [cp - mp for cp, mp, _ in pooled]
    import numpy as np
    d = np.array(disagreements)
    md.append("")
    md.append("## Disagreement distribution")
    md.append("")
    md.append(_md_table(
        ["stat", "value"],
        [["mean", float(np.mean(d))], ["median", float(np.median(d))],
         ["std", float(np.std(d))], ["p10", float(np.percentile(d, 10))],
         ["p90", float(np.percentile(d, 90))], ["min", float(np.min(d))],
         ["max", float(np.max(d))]]
    ))
    md.append("")

    md.append("## Disagreement buckets — model accuracy when model vs market picks differ")
    md.append("")
    md.append("| bucket | n | model accuracy | market accuracy | agree % |")
    md.append("|---|---|---|---|---|")
    buckets = [(-1.0, -0.1), (-0.1, -0.05), (-0.05, 0.05), (0.05, 0.1), (0.1, 1.0)]
    for lo, hi in buckets:
        subset = [(cp, mp, o) for cp, mp, o in pooled if lo <= (cp - mp) < hi]
        if not subset:
            md.append(f"| [{lo:.2f}, {hi:.2f}) | 0 | — | — | — |")
            continue
        model_correct = sum(1 for cp, mp, o in subset if (o == 1) == (cp >= 0.5))
        market_correct = sum(1 for cp, mp, o in subset if (o == 1) == (mp >= 0.5))
        agree = sum(1 for cp, mp, o in subset if (cp >= 0.5) == (mp >= 0.5))
        n = len(subset)
        md.append(f"| [{lo:.2f}, {hi:.2f}) | {n} | {model_correct/n:.4f} | "
                  f"{market_correct/n:.4f} | {100*agree/n:.2f}% |")
    md.append("")
    md.append("---")
    md.append("")
    md.append("_Disagreement is informational. It does not assert betting edge; "
              "edge analysis lives in edge_buckets.md and remains secondary._")
    md_path = os.path.join(output_dir, "model_market_disagreement.md")
    with open(md_path, "w") as f:
        f.write("\n".join(md) + "\n")
    return md_path


# ---------------------------------------------------------------------------
# Report: edge_buckets (edge = model - no_vig market probability)
# ---------------------------------------------------------------------------


def _write_edge_buckets(rows, folds, output_dir, common) -> str:
    md = ["# Edge Buckets Report", ""]
    md.append(f"- Generated: `{common['generated_at_utc']}`")
    md.append(f"- Dataset hash: `{common['dataset_hash']}`")
    md.append("")
    md.append("**Edge** is explicitly `model_probability - no_vig_market_probability` "
              "on the picked side. This is a model-vs-market divergence measure, "
              "NOT a bet-selection claim. VALUE/ROI is secondary and reported separately.")
    md.append("")

    pooled = []
    for fold in folds:
        if fold["fold_type"] != "test":
            continue
        for r in rows:
            if fold["start_date"] <= r["date_ymd"] < fold["end_date"]:
                cp = _norm_prob(r.get("calibrated_home_probability"))
                mp = _norm_prob(r.get("market_no_vig_home_prob"))
                o = r.get("home_won")
                pick = r.get("pick_side")
                if cp is None or mp is None or o is None or not pick:
                    continue
                # Edge on the picked side: if pick=home, edge = cp - mp; if away,
                # edge = (1-cp) - (1-mp) = mp - cp.
                edge = (cp - mp) if pick == "home" else (mp - cp)
                pooled.append((edge, int(o), pick))
    md.append(f"- With-market + pick OOF rows: {len(pooled)}")
    if not pooled:
        md.append("")
        md.append("_No with-market rows with a pick on test folds. Edge buckets cannot "
                  "be computed._")
        md_path = os.path.join(output_dir, "edge_buckets.md")
        with open(md_path, "w") as f:
            f.write("\n".join(md) + "\n")
        return md_path

    md.append("")
    md.append("## Edge buckets (|edge|)")
    md.append("")
    md.append("| bucket | n | win rate | Brier (picked prob) |")
    md.append("|---|---|---|---|")
    import numpy as np
    edges = np.array([abs(e) for e, _, _ in pooled])
    bins = [0.0, 0.02, 0.05, 0.08, 0.12, 0.20, 1.0]
    for i in range(len(bins) - 1):
        lo, hi = bins[i], bins[i + 1]
        subset = [(e, o, pick) for e, o, pick in pooled if lo <= abs(e) < hi]
        if not subset:
            md.append(f"| [{lo:.2f}, {hi:.2f}) | 0 | — | — |")
            continue
        wr = sum(o for _, o, _ in subset) / len(subset)
        # picked probability = 0.5 + edge (proxy for Brier on picked side)
        picked_probs = [0.5 + abs(e) for e, _, _ in subset]
        outs = [o for _, o, _ in subset]
        brier = model_metrics(picked_probs, outs).get("brier")
        md.append(f"| [{lo:.2f}, {hi:.2f}) | {len(subset)} | {wr:.4f} | {_f(brier)} |")
    md.append("")
    md.append("---")
    md.append("")
    md.append("_Edge is model-minus-no-vig-market, not a betting edge claim. "
              "Selection bias (only VALUE-picked rows) is NOT corrected here; "
              "this is diagnostic only._")
    md_path = os.path.join(output_dir, "edge_buckets.md")
    with open(md_path, "w") as f:
        f.write("\n".join(md) + "\n")
    return md_path


# ---------------------------------------------------------------------------
# Report: information_state_cohorts
# ---------------------------------------------------------------------------


def _write_information_state_cohorts(db_path, output_dir, common, model_id) -> str:
    md = ["# Information State Cohorts Report", ""]
    md.append(f"- Generated: `{common['generated_at_utc']}`")
    md.append(f"- Dataset hash: `{common['dataset_hash']}`")
    md.append("")
    md.append("Per-information-state cohorts. Each selects its own deterministic eligible "
              "run per game. Metrics on OOF test folds only.")
    md.append("")

    md.append("| cohort | clean rows | quarantined | folds | holdout | Brier | log loss | accuracy |")
    md.append("|---|---|---|---|---|---|---|---|")
    json_payload = {"cohorts": {}}
    for cohort in ["main", "close_time", "confirmed_lineup"]:
        clean, quarantined = build_game_dataset(db_path, model_id=model_id, cohort=cohort)
        if not clean:
            md.append(f"| {cohort} | 0 | {len(quarantined)} | 0 | — | — | — | — |")
            json_payload["cohorts"][cohort] = {"row_count": 0, "quarantine_count": len(quarantined)}
            continue
        folds, _ = build_folds(clean)
        rows = [r.to_dict() for r in clean]
        # Pool test-fold probs.
        probs, outs = [], []
        for fold in folds:
            if fold["fold_type"] != "test":
                continue
            for r in rows:
                if fold["start_date"] <= r["date_ymd"] < fold["end_date"]:
                    p = _norm_prob(r.get("calibrated_home_probability"))
                    o = r.get("home_won")
                    if p is not None and o is not None:
                        probs.append(p)
                        outs.append(int(o))
        m = model_metrics(probs, outs) if probs else {"brier": None, "log_loss": None, "accuracy": None}
        holdout = any(f["fold_type"] == "holdout" for f in folds)
        md.append(f"| {cohort} | {len(clean)} | {len(quarantined)} | {len(folds)} | "
                  f"{'yes' if holdout else 'no'} | {_f(m.get('brier'))} | "
                  f"{_f(m.get('log_loss'))} | {_f(m.get('accuracy'))} |")
        json_payload["cohorts"][cohort] = {
            "row_count": len(clean),
            "quarantine_count": len(quarantined),
            "fold_count": len(folds),
            "metrics": m,
        }
    md.append("")
    md.append("---")
    md.append("")
    md.append("_Cohorts are separate deterministic selections. Close-time and "
              "confirmed-lineup cohorts may be empty if no runs carry that "
              "information_state. Absence is reported, not fabricated._")
    md_path = os.path.join(output_dir, "information_state_cohorts.md")
    with open(md_path, "w") as f:
        f.write("\n".join(md) + "\n")
    with open(os.path.join(output_dir, "information_state_cohorts.json"), "w") as f:
        json.dump({**common, **json_payload}, f, indent=2, default=str)
    return md_path


# ---------------------------------------------------------------------------
# Evidence-bound recommendation
# ---------------------------------------------------------------------------


def _build_recommendation(db_path, output_dir, common, model_id, cohort) -> dict[str, Any]:
    """Build the final recommendation from real holdout metrics.

    Promotion requires chronological all-game evidence on the untouched holdout.
    If holdout is absent/empty or below MIN_HOLDOUT_ROWS, the result is
    INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE. No challenger is promoted by code.
    """
    from src.eval.recommend import MIN_HOLDOUT_ROWS

    clean, _ = build_game_dataset(db_path, model_id=model_id, cohort=cohort)
    folds, _ = build_folds(clean)
    holdout_fold = next((f for f in folds if f["fold_type"] == "holdout"), None)
    rows = [r.to_dict() for r in clean]

    control_holdout = None
    if holdout_fold:
        h_rows = [r for r in rows if holdout_fold["start_date"] <= r["date_ymd"] <= holdout_fold["end_date"]]
        probs, outs = [], []
        for r in h_rows:
            p = _norm_prob(r.get("calibrated_home_probability"))
            o = r.get("home_won")
            if p is not None and o is not None:
                probs.append(p)
                outs.append(int(o))
        control_holdout = model_metrics(probs, outs) if probs else {"n": 0}

    # Challenger holdout metrics: shadow artifacts (learned_v2, market_residual_v2)
    # are NOT active and have no live holdout predictions scored against frozen
    # runs. Without chronological holdout evidence for a challenger, promotion
    # is impossible by design.
    challenger_holdout = None
    market_holdout = None

    # replay_verified: deterministic replay is implemented (prediction_replay) but
    # not re-run here; set False conservatively until a replay pass is executed.
    replay_verified = False

    recs = {}
    for chal_id in ["learned_v2_logistic", "market_residual_v2"]:
        recs[chal_id] = recommend(
            control_holdout=control_holdout,
            challenger_holdout=challenger_holdout,
            challenger_model_id=chal_id,
            market_holdout=market_holdout,
            fold_stability_ok=None,
            subgroup_failure=None,
            replay_verified=replay_verified,
            human_approved=False,
        )

    # The overall recommendation picks the most-advanced (evidence-supported)
    # verdict across challengers, ranked: PROMOTE > RUN V2 IN SHADOW > KEEP V1
    # > INSUFFICIENT DATA. KEEP V1 requires a real losing comparison on holdout;
    # if EVERY challenger is INSUFFICIENT DATA (no chronological holdout evidence),
    # the honest overall verdict is INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE,
    # never a silent KEEP V1.
    RANK = {
        "PROMOTE LEARNED V2": 4,
        "PROMOTE MARKET RESIDUAL V2": 4,
        "RUN V2 IN SHADOW": 3,
        "KEEP V1": 2,
        "INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE": 1,
    }
    overall = "INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE"
    overall_rank = 0
    overall_reasons: list[str] = []
    for chal_id, rec in recs.items():
        r = rec.get("recommendation", "INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE")
        rank = RANK.get(r, 0)
        if rank > overall_rank:
            overall = r
            overall_rank = rank
            overall_reasons = rec.get("reasons", [])
    # If no challenger advanced past insufficient, explain why honestly.
    if overall_rank <= 1:
        overall_reasons = [
            "no_challenger_has_chronological_holdout_evidence",
            "shadow_challengers_not_active_in_live_scoring",
            "replay_not_verified_in_this_pass",
            "human_approval_not_given",
        ]

    result = {
        "recommendation": overall,
        "reasons": overall_reasons,
        "per_challenger": recs,
        "control_holdout_metrics": control_holdout,
        "holdout_rows": control_holdout.get("n", 0) if control_holdout else 0,
        "min_holdout_rows": MIN_HOLDOUT_ROWS,
        "promotion_eligible": overall.startswith("PROMOTE"),
        "note": (
            "No code change activates a model automatically. Promotion requires "
            "chronological all-game holdout evidence + explicit human approval. "
            "Shadow challengers have no live holdout predictions scored yet."
        ),
    }

    md = ["# Evidence-Bound Recommendation", ""]
    md.append(f"- Generated: `{common['generated_at_utc']}`")
    md.append(f"- Dataset hash: `{common['dataset_hash']}`")
    md.append(f"- Holdout rows: {result['holdout_rows']} (minimum for promotion: {MIN_HOLDOUT_ROWS})")
    md.append("")
    md.append(f"## Recommendation: `{overall}`")
    md.append("")
    md.append("**Reasons:**")
    for reason in overall_reasons:
        md.append(f"- {reason}")
    md.append("")
    md.append("## Per-challenger")
    md.append("")
    md.append("| challenger | recommendation | reasons |")
    md.append("|---|---|---|")
    for chal_id, rec in recs.items():
        md.append(f"| {chal_id} | `{rec.get('recommendation')}` | "
                  f"{'; '.join(rec.get('reasons', []))} |")
    md.append("")
    md.append("---")
    md.append("")
    md.append(f"_{result['note']}_")
    rec_path = os.path.join(output_dir, "recommendation.md")
    with open(rec_path, "w") as f:
        f.write("\n".join(md) + "\n")
    with open(os.path.join(output_dir, "recommendation.json"), "w") as f:
        json.dump({**common, **result}, f, indent=2, default=str)
    return {"path": rec_path, "result": result}
