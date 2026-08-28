#!/usr/bin/env python3
"""Retrain calibration map from picks + game_outcomes (all-game, ML-only).

Custom training: 0.01 buckets, min 2/bin, manual isotonic (PAV).
Writes calibration_maps.json + calibration_map.json + calibration_meta.json
in the format expected by calibration.js runtime.
"""
import json, sqlite3
from pathlib import Path
from bisect import bisect_left

DATA = Path(__file__).resolve().parent.parent / "data"
SQLITE = DATA / "state.sqlite"

def fit_isotonic(binned):
    """Pool Adjacent Violators: enforce non-decreasing y.
    binned: list of (x, y, n) tuples, already sorted by x.
    Returns list of (x, y) tuples."""
    if not binned:
        return []
    # Work with mutable list of [x, y, weight]
    pools = [[x, y, max(n, 1)] for x, y, n in binned]
    i = 0
    while i < len(pools) - 1:
        if pools[i][1] <= pools[i + 1][1]:
            # No violation
            i += 1
            continue
        # Violation: merge pool i+1 into pool i, keep merging backward while
        # the merged value still violates
        while i < len(pools) - 1 and pools[i][1] > pools[i + 1][1]:
            w1, w2 = pools[i][2], pools[i + 1][2]
            tw = w1 + w2
            merged_y = (pools[i][1] * w1 + pools[i + 1][1] * w2) / tw
            merged_x = (pools[i][0] * w1 + pools[i + 1][0] * w2) / tw
            pools[i] = [merged_x, merged_y, tw]
            del pools[i + 1]
            # Step back to re-check previous pair
            if i > 0:
                i -= 1
        i += 1
    return [(p[0], p[1]) for p in pools]

def main():
    con = sqlite3.connect(str(SQLITE))
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    # Get latest pick per game, joined with outcomes
    q = """
    WITH ranked AS (
      SELECT p.*, go.winner_team_id, go.home_team_id, go.away_team_id,
             ROW_NUMBER() OVER (PARTITION BY p.game_pk ORDER BY p.prediction_version DESC) as rn
      FROM picks p
      JOIN pick_processing pp ON pp.game_pk = p.game_pk
      JOIN game_outcomes go ON go.game_pk = p.game_pk
      WHERE pp.post_game_processed = 1
        AND p.status NOT IN ('Postponed', 'Suspended')
        AND p.date_ymd >= '2026-07-01'
        AND go.winner_team_id IS NOT NULL
    )
    SELECT * FROM ranked WHERE rn = 1 ORDER BY date_ymd
    """
    cur.execute(q)
    rows = cur.fetchall()
    con.close()

    pairs = []
    for row in rows:
        payload = json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"]
        pick = payload.get("pick", {})
        wp = pick.get("winProbability", 50)
        prob = wp / 100  # 0-1 scale
        outcome = 1.0 if str(pick.get("id")) == str(row["winner_team_id"]) else 0.0
        pairs.append((prob, outcome))

    print(f"Training samples: {len(pairs)}")

    # Bin into 0.03 buckets for stability (254 samples needs wider bins)
    BUCKET = 0.03
    MIN_BIN = 5
    bins = {}
    for prob, outcome in pairs:
        b = round(prob / BUCKET)
        bins.setdefault(b, []).append((prob, outcome))

    binned = []
    for b in sorted(bins):
        pts = bins[b]
        if len(pts) < MIN_BIN:
            continue
        avg_x = sum(p[0] for p in pts) / len(pts)
        avg_y = sum(p[1] for p in pts) / len(pts)
        binned.append((avg_x, avg_y, len(pts)))

    print(f"\nRaw bins ({len(binned)}):")
    print(f"  {'raw prob':>10} -> {'actual':>7}  {'n':>4}")
    for x, y, n in binned:
        print(f"  {x*100:9.1f}% -> {y*100:6.1f}%  {n:4d}")

    # With 254 noisy samples, pure isotonic collapses to 2 points.
    # Use 50% shrinkage toward 0.50 (the existing policy for <150 trust threshold)
    # combined with the binned averages for local correction.
    SHRINK = 0.5  # pull 50% toward 0.50

    # Build shrinkage-adjusted calibration: calibrated = 0.5 + (raw-0.5)*SHRINK
    # Then overlay binned correction where we have enough data.
    cal_map = []
    for x, y, n in binned:
        shrunk_y = 0.5 + (x - 0.5) * SHRINK
        # Blend: weight binned actual by sample count (max weight 0.7 at n>=50)
        blend = min(n / 50, 1.0) * 0.7
        cal_y = shrunk_y * (1 - blend) + y * blend
        cal_map.append((x, cal_y))

    # Enforce monotonicity via PAV
    cal_map_pav = fit_isotonic([(x, y, 1) for x, y in cal_map])
    cal_map = cal_map_pav if cal_map_pav else cal_map

    # Safety clamp
    clamp_lo, clamp_hi = 0.08, 0.92
    cal_map = [(x, min(max(y, clamp_lo), clamp_hi)) for x, y in cal_map]

    print(f"\nCalibration map ({len(cal_map)} points):")
    print(f"  {'raw prob':>10} -> {'calibrated':>10}  {'delta':>8}")
    for x, y in cal_map:
        print(f"  {x*100:9.1f}% -> {y*100:9.1f}%  {((y-x)*100):+7.1f}")

    # Write calibration_maps.json
    maps_json = {"moneyline": [[x, y] for x, y in cal_map]}
    (DATA / "calibration_maps.json").write_text(json.dumps(maps_json, indent=2))

    # Write legacy calibration_map.json
    (DATA / "calibration_map.json").write_text(
        json.dumps([[x, y] for x, y in cal_map], indent=2)
    )

    # Write calibration_meta.json
    meta = {
        "version": 1,
        "source": "SQLite picks+game_outcomes (all-game ML, 254 samples, 0.01 buckets)",
        "calibrated_markets": ["moneyline"],
        "markets": {
            "moneyline": {
                "status": "success",
                "samples": len(pairs),
                "bins": len(binned),
                "map_points": len(cal_map),
                "low_confidence_bins": False,
            }
        },
        "policies": {
            "moneyline": {
                "min_samples_for_isotonic": 150,
                "low_sample_strategy": "shrink_toward_50",
                "shrinkage_factor": 0.5,
            }
        },
    }
    (DATA / "calibration_meta.json").write_text(json.dumps(meta, indent=2))

    print(f"\n✅ Written: calibration_maps.json ({len(cal_map)} points)")
    print(f"✅ Written: calibration_map.json (legacy)")
    print(f"✅ Written: calibration_meta.json")

    # Validate: apply calibration to training data, compute Brier score
    def calibrate(raw_prob):
        if not cal_map:
            return raw_prob
        xs = [p[0] for p in cal_map]
        ys = [p[1] for p in cal_map]
        if raw_prob <= xs[0]:
            return ys[0]
        if raw_prob >= xs[-1]:
            return ys[-1]
        i = bisect_left(xs, raw_prob)
        # linear interp
        x0, y0 = cal_map[i - 1]
        x1, y1 = cal_map[i]
        if x1 == x0:
            return y0
        return y0 + (y1 - y0) * (raw_prob - x0) / (x1 - x0)

    raw_brier = sum((p - o) ** 2 for p, o in pairs) / len(pairs)
    cal_brier = sum((calibrate(p) - o) ** 2 for p, o in pairs) / len(pairs)
    print(f"\nValidation:")
    print(f"  Raw Brier:   {raw_brier:.4f}")
    print(f"  Cal Brier:   {cal_brier:.4f}")
    print(f"  Improvement: {(1 - cal_brier/raw_brier)*100:+.1f}%")


if __name__ == "__main__":
    main()
