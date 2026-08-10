#!/usr/bin/env python3
"""Phase 3 offline analysis — READ ONLY. No production writes."""

from __future__ import annotations

import json
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "state.sqlite"
MAPS = ROOT / "data" / "calibration_maps.json"


def st(sub):
    n = len(sub)
    if not n:
        return None
    wins = sum(1 for r in sub if r["result"] == "win")
    stake = sum(float(r["units_staked"] or 0) for r in sub)
    pl = sum(float(r["units_pl"] or 0) for r in sub)
    clvs = [float(r["clv"]) for r in sub if r["clv"] is not None]
    return {
        "n": n,
        "wr": round(wins / n * 100, 1),
        "roi": round(pl / stake * 100, 1) if stake else None,
        "pl": round(pl, 2),
        "avg_clv": round(sum(clvs) / len(clvs), 3) if clvs else None,
        "clv_n": len(clvs),
    }


def fmt(s):
    if not s:
        return "n=0"
    return (
        f"n={s['n']:3d} wr={s['wr']:5.1f}% "
        f"roi={s['roi'] if s['roi'] is not None else 'n/a':>6}% "
        f"pl={s['pl']:7.2f} clv={s['avg_clv']} (n_clv={s['clv_n']})"
    )


def interpolate_map(x: float, points: list[list[float]]) -> float:
    if not points:
        return x
    pts = sorted(points, key=lambda p: p[0])
    if x <= pts[0][0]:
        return pts[0][1]
    if x >= pts[-1][0]:
        return pts[-1][1]
    for i in range(len(pts) - 1):
        x0, y0 = pts[i]
        x1, y1 = pts[i + 1]
        if x0 <= x <= x1:
            if x1 == x0:
                return y0
            t = (x - x0) / (x1 - x0)
            return y0 + t * (y1 - y0)
    return x


def main() -> int:
    if not DB.exists():
        print(f"missing {DB}", file=sys.stderr)
        return 1

    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    rows = db.execute(
        """
        SELECT side, team, odds, edge, model_prob, fair_prob,
               units_staked, units_pl, result, clv, date_ymd
        FROM bet_ledger
        WHERE market = 'moneyline' AND status = 'settled'
        ORDER BY recommended_at
        """
    ).fetchall()
    rows = [dict(r) for r in rows]
    print("=== PHASE 3.1 SEGMENT ANALYSIS ===")
    print(f"settled moneyline rows: {len(rows)}")

    segments: dict[str, list] = defaultdict(list)
    for r in rows:
        segments[f"side:{r['side']}"].append(r)
        e = float(r["edge"] or 0)
        segments[
            "edge:<5"
            if e < 5
            else "edge:5-8"
            if e < 8
            else "edge:8-12"
            if e < 12
            else "edge:12+"
        ].append(r)
        o = float(r["odds"] or 0)
        segments[
            "odds:dog"
            if o > 0
            else "odds:shortfav"
            if o > -110
            else "odds:fav"
            if o > -160
            else "odds:heavy"
        ].append(r)
        mp = float(r["model_prob"] or 0)
        # model_prob stored as percent (e.g. 58) in ledger
        segments[
            "prob:<55"
            if mp < 55
            else "prob:55-60"
            if mp < 60
            else "prob:60-65"
            if mp < 65
            else "prob:65+"
        ].append(r)
        segments[f"month:{(r['date_ymd'] or '')[:7]}"].append(r)

    for k in sorted(segments):
        print(f"{k:16s} {fmt(st(segments[k]))}")

    print("\n=== side x edge ===")
    for side in ("home", "away"):
        for eb, lo, hi in (
            ("edge:<5", None, 5),
            ("edge:5-8", 5, 8),
            ("edge:8-12", 8, 12),
            ("edge:12+", 12, None),
        ):
            sub = []
            for r in rows:
                if r["side"] != side:
                    continue
                e = float(r["edge"] or 0)
                if lo is not None and e < lo:
                    continue
                if hi is not None and e >= hi:
                    continue
                sub.append(r)
            s = st(sub)
            if s:
                print(f"{side:4s} {eb:10s} {fmt(s)}")

    print("\n=== PHASE 3.2 CALIBRATION (bet-side model_prob) ===")
    # model_prob is percent of the selected side winning
    bins = [(40, 45), (45, 50), (50, 55), (55, 60), (60, 65), (65, 70), (70, 80)]
    for lo, hi in bins:
        sub = [r for r in rows if lo <= float(r["model_prob"] or 0) < hi]
        if not sub:
            continue
        pred = sum(float(r["model_prob"] or 0) for r in sub) / len(sub)
        actual = 100 * sum(1 for r in sub if r["result"] == "win") / len(sub)
        err = actual - pred
        print(
            f"prob {lo}-{hi}: n={len(sub):3d} pred={pred:5.1f}% actual={actual:5.1f}% err={err:+5.1f}%"
        )

    # Brier model vs fair (as fractions)
    def brier(key):
        vals = []
        for r in rows:
            p = float(r[key] or 0)
            if p > 1.5:  # percent scale
                p = p / 100.0
            if not (0 < p < 1):
                continue
            y = 1.0 if r["result"] == "win" else 0.0
            vals.append((p - y) ** 2)
        return sum(vals) / len(vals) if vals else None, len(vals)

    bm, nm = brier("model_prob")
    bf, nf = brier("fair_prob")
    print(f"Brier model_prob: {bm:.4f} (n={nm})")
    print(f"Brier fair_prob:  {bf:.4f} (n={nf})")

    maps = json.loads(MAPS.read_text()) if MAPS.exists() else {}
    pts = maps.get("moneyline") or []
    print(f"\nCurrent map_points ({len(pts)}): {pts}")
    print("Interpolation check (raw -> calibrated):")
    for raw in (0.50, 0.52, 0.55, 0.58, 0.60, 0.65, 0.70):
        cal = interpolate_map(raw, pts)
        print(f"  raw {raw:.2f} -> cal {cal:.4f}  (delta {cal-raw:+.4f})")

    # Proposed denser map from observed buckets (fraction scale)
    proposed = []
    for lo, hi in bins:
        sub = [r for r in rows if lo <= float(r["model_prob"] or 0) < hi]
        if len(sub) < 3:
            continue
        pred = sum(float(r["model_prob"] or 0) for r in sub) / len(sub) / 100.0
        actual = sum(1 for r in sub if r["result"] == "win") / len(sub)
        proposed.append([round(pred, 4), round(actual, 4), len(sub)])
    print("\nProposed map_points from settled VALUE ledger (pred, actual, n):")
    for p in proposed:
        print(f"  [{p[0]}, {p[1]}]  # n={p[2]}")
    print(
        "NOTE: sample is VALUE-selected bets only (biased vs full pick population)."
        " Full recalibration should use prediction_outcomes / all graded picks."
    )

    print("\n=== PHASE 3.3 MARKET BLEND EXPERIMENT (offline) ===")
    usable = []
    for r in rows:
        m = float(r["model_prob"] or 0)
        f = float(r["fair_prob"] or 0)
        if m > 1.5:
            m /= 100.0
        if f > 1.5:
            f /= 100.0
        if not (0 < m < 1 and 0 < f < 1):
            continue
        y = 1.0 if r["result"] == "win" else 0.0
        usable.append((m, f, y))
    print(f"rows with model+fair: {len(usable)}")
    for w in (0.0, 0.1, 0.2, 0.22, 0.3, 0.5, 1.0):
        # blend: (1-w)*model + w*fair
        scores = [((1 - w) * m + w * f - y) ** 2 for m, f, y in usable]
        b = sum(scores) / len(scores) if scores else None
        label = "model" if w == 0 else ("fair" if w == 1 else f"blend w={w}")
        print(f"  {label:14s} Brier={b:.4f}" if b is not None else f"  {label}: n/a")

    print("\n=== PHASE 3.4 LLM A/B (agentShift pairs) ===")
    # Count agentShift in picks payload
    try:
        pick_rows = db.execute(
            "SELECT game_pk, payload FROM picks WHERE payload LIKE '%agentShift%'"
        ).fetchall()
        applied = 0
        rejected = 0
        for pr in pick_rows:
            try:
                payload = json.loads(pr[1] or "{}")
            except json.JSONDecodeError:
                continue
            shift = payload.get("agentShift") or {}
            if shift.get("applied"):
                applied += 1
            if shift.get("rejected"):
                rejected += 1
        print(f"picks with agentShift key: {len(pick_rows)}")
        print(f"  applied=true: {applied}")
        print(f"  rejected=true: {rejected}")
        print(
            "LLM probability nudge is explanation-only / rejected by design"
            " (see tests + sanitize). Paired Brier eval expected empty."
        )
    except Exception as exc:
        print(f"agentShift scan failed: {exc}")

    # Try llm_value_eval import path summary without side effects
    try:
        sys.path.insert(0, str(ROOT))
        from src.evolution.llm_value_eval import _load_shift_pairs, _load_home_win_labels
        from src.utils import DATA_DIR

        labels = _load_home_win_labels(DATA_DIR / "evolution" / "prediction_outcomes.csv")
        pairs = _load_shift_pairs(DB)
        joined = set(labels) & set(pairs)
        print(f"llm_value_eval labels: {len(labels)}, shift pairs: {len(pairs)}, joined: {len(joined)}")
    except Exception as exc:
        print(f"llm_value_eval import/run helper: {exc}")

    print("\nDONE (read-only).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
