#!/usr/bin/env python3
"""Edge analysis v2: SQLite-based, deduped to latest pick version per game."""
import sqlite3, json, statistics as st
from collections import defaultdict

DB = "/root/MLB-Stats-Bot/data/state.sqlite"
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

# Get latest pick per game_pk (highest prediction_version), joined with outcome
q = """
WITH ranked AS (
  SELECT p.*, go.winner_team_id, go.home_score, go.away_score, go.first_inning_any_run,
         ROW_NUMBER() OVER (PARTITION BY p.game_pk ORDER BY p.prediction_version DESC) as rn
  FROM picks p
  JOIN pick_processing pp ON pp.game_pk = p.game_pk
  LEFT JOIN game_outcomes go ON go.game_pk = p.game_pk
  WHERE pp.post_game_processed = 1
    AND p.status NOT IN ('Postponed', 'Suspended')
    AND p.date_ymd >= '2026-07-28'
)
SELECT * FROM ranked WHERE rn = 1
ORDER BY date_ymd
"""
rows = cur.fetchall()
print(f"Total deduped picks (latest version, processed): {len(rows)}")

settled = [r for r in rows if r["winner_team_id"] is not None]
unsettled = [r for r in rows if r["winner_team_id"] is None]
print(f"Settled (has winner): {len(settled)}  Unsettled: {len(unsettled)}")

def get_pick_id(r):
    """Extract pick team id from payload JSON."""
    import json
    try:
        payload = json.loads(r["payload"]) if isinstance(r["payload"], str) else r["payload"]
        return payload.get("pick", {}).get("id")
    except:
        return None

def get_pick_conf(r):
    import json
    try:
        payload = json.loads(r["payload"]) if isinstance(r["payload"], str) else r["payload"]
        c = payload.get("modelConfidence")
        if c is not None: return float(c)
        # fallback: max of home/away prob
        hp = payload.get("home", {}).get("winProbability")
        ap = payload.get("away", {}).get("winProbability")
        vals = [float(x) for x in [hp, ap] if x is not None]
        return max(vals) if vals else 0
    except:
        return 0

def is_correct(r):
    pid = get_pick_id(r)
    return pid is not None and str(pid) == str(r["winner_team_id"])

W = sum(1 for r in settled if is_correct(r))
L = len(settled) - W
print(f"\n=== OVERALL (Jul 28 - Aug 17, deduped) ===")
print(f"W:{W} L:{L}  winrate={W/(W+L)*100:.1f}%")

# Daily
by_day = defaultdict(lambda: [0,0])
for r in settled:
    by_day[r["date_ymd"]][0 if is_correct(r) else 1] += 1

print(f"\n=== DAILY WINRATE ===")
rates = []
for d in sorted(by_day):
    w, l = by_day[d]
    rate = w/(w+l)*100
    rates.append(rate)
    bar = "█" * int(rate/2)
    print(f"  {d}: {w:>2}W {l:>2}L  {rate:5.1f}%  n={w+l:>3} {bar}")

if rates:
    print(f"\n  mean={st.mean(rates):.1f}%  median={st.median(rates):.1f}%  "
          f"min={min(rates):.1f}%  max={max(rates):.1f}%  stdev={st.pstdev(rates):.1f}%")

# By confidence bin (model_confidence from payload)
print(f"\n=== BY MODEL CONFIDENCE ===")
conf_bins = defaultdict(lambda: [0,0])
for r in settled:
    c = get_pick_conf(r)
    if c < 0.50: b = "<0.50"
    elif c < 0.55: b = "0.50-0.55"
    elif c < 0.60: b = "0.55-0.60"
    elif c < 0.65: b = "0.60-0.65"
    else: b = ">=0.65"
    conf_bins[b][0 if is_correct(r) else 1] += 1

for b in ["<0.50","0.50-0.55","0.55-0.60","0.60-0.65",">=0.65"]:
    if b in conf_bins:
        w, l = conf_bins[b]
        print(f"  conf {b:>10}: {w:>3}W {l:>3}L  {w/(w+l)*100:5.1f}%  (n={w+l})")

# By pick_source
print(f"\n=== BY PICK SOURCE ===")
src_bins = defaultdict(lambda: [0,0])
for r in settled:
    import json as _j
    try:
        payload = _j.loads(r["payload"]) if isinstance(r["payload"], str) else r["payload"]
        src = payload.get("pickSource") or payload.get("pick_source") or "unknown"
    except:
        src = "unknown"
    src_bins[src][0 if is_correct(r) else 1] += 1
for s, (w, l) in sorted(src_bins.items(), key=lambda x: -sum(x[1])):
    print(f"  {s:>20}: {w:>3}W {l:>3}L  {w/(w+l)*100:5.1f}%  (n={w+l})")

# Home vs Away pick
print(f"\n=== HOME PICK vs AWAY PICK ===")
home_picks = [r for r in settled if r["pick_team_id"] == r["home_team_id"] or 
              (r["pick_name"] and "home" in str(r["payload"] or "").lower())]
# simpler: check if pick is home team
for r in settled:
    pass  # need team side from payload

# Edge: model_prob vs implied
# Check what's in payload for edge/value
sample = settled[0] if settled else None
if sample:
    payload = json.loads(cur.execute(
        "SELECT payload FROM picks WHERE game_pk=? AND prediction_version=?",
        (sample["game_pk"], 1)
    ).fetchone()[0]) if False else None

# Try reading full payload from one settled row
print(f"\n=== PAYLOAD STRUCTURE (sample) ===")
r = cur.execute("""
  SELECT p.payload, p.game_pk FROM picks p
  JOIN pick_processing pp ON pp.game_pk = p.game_pk
  WHERE pp.post_game_processed = 1 AND p.date_ymd >= '2026-08-01'
  AND p.prediction_version = (SELECT MAX(p2.prediction_version) FROM picks p2 WHERE p2.game_pk = p.game_pk)
  LIMIT 1
""").fetchone()
if r:
    payload = json.loads(r["payload"])
    print(f"  game_pk: {r['game_pk']}")
    print(f"  payload keys: {list(payload.keys())[:30]}")
    if "pick" in payload: print(f"  pick: {payload['pick']}")
    if "modelConfidence" in payload: print(f"  modelConfidence: {payload['modelConfidence']}")
    if "home" in payload: print(f"  home keys: {list(payload['home'].keys())[:10]}")
    if "away" in payload: print(f"  away keys: {list(payload['away'].keys())[:10]}")

con.close()
