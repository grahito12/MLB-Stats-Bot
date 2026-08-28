#!/usr/bin/env python3
"""Edge analysis: daily winrate, edge/confidence bins, variance drivers."""
import sqlite3, json, statistics as st
from collections import defaultdict, Counter

DB = "/root/MLB-Stats-Bot/data/state.sqlite"
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

# Pull settled decisions joined with outcomes + settlements
q = """
SELECT
  pd.date_ymd AS date,
  pd.market,
  pd.model_pick_team_id,
  pd.model_home_prob, pd.model_away_prob,
  pd.calibrated_home_prob, pd.calibrated_away_prob,
  pd.edge, pd.value_model_prob, pd.market_fair_prob,
  pd.units_staked, pd.reason_codes,
  go.winner_team_id, go.home_score, go.away_score,
  s.result, s.units_pl, s.clv
FROM prediction_decisions pd
LEFT JOIN game_outcomes go ON go.game_pk = pd.game_pk
LEFT JOIN settlements s ON s.decision_id = pd.decision_id
WHERE pd.status = 'committed' OR s.result IS NOT NULL
"""
rows = cur.fetchall()
print(f"TOTAL decision rows (committed/settled): {len(rows)}")

# Filter to actual settled
settled = [r for r in rows if r["result"] in ("win", "loss", "push")]
print(f"Settled (win/loss/push): {len(settled)}")

def win_of(r):
    return r["result"] == "win"

# ---- Overall ----
overall_w = sum(1 for r in settled if r["result"]=="win")
overall_l = sum(1 for r in settled if r["result"]=="loss")
overall_p = sum(1 for r in settled if r["result"]=="push")
print(f"\n=== OVERALL ===")
print(f"W:{overall_w} L:{overall_l} P:{overall_p}  winrate={overall_w/(overall_w+overall_l)*100:.1f}%")

# ---- Daily winrate ----
by_day = defaultdict(lambda: [0,0,0])
for r in settled:
    d = r["date"]
    if r["result"]=="win": by_day[d][0]+=1
    elif r["result"]=="loss": by_day[d][1]+=1
    else: by_day[d][2]+=1

print(f"\n=== DAILY WINRATE (sorted by date) ===")
daily_rates = []
for d in sorted(by_day):
    w,l,p = by_day[d]
    tot = w+l
    rate = w/tot*100 if tot else 0
    daily_rates.append(rate)
    print(f"{d}: {w:>2}W {l:>2}L {p:>1}P  -> {rate:5.1f}%  (n={tot})")

if daily_rates:
    print(f"\nDaily rate: mean={st.mean(daily_rates):.1f}%  median={st.median(daily_rates):.1f}%  "
          f"min={min(daily_rates):.1f}%  max={max(daily_rates):.1f}%  "
          f"stdev={st.pstdev(daily_rates):.1f}  n_days={len(daily_rates)}")
    above = sum(1 for x in daily_rates if x>50)
    below = sum(1 for x in daily_rates if x<50)
    print(f"Days >50%: {above}   Days <50%: {below}   Days =50%: {len(daily_rates)-above-below}")

# ---- Edge bins ----
print(f"\n=== WINRATE BY EDGE BIN ===")
edge_bins = defaultdict(lambda: [0,0])
for r in settled:
    e = r["edge"] or 0
    b = f"{int(e*10)/10:.1f}-{int(e*10+1)/10:.1f}" if e>=0 else "<0"
    if e<0: b="<0"
    elif e<0.05: b="0.0-0.05"
    elif e<0.10: b="0.05-0.10"
    elif e<0.15: b="0.10-0.15"
    elif e<0.20: b="0.15-0.20"
    else: b=">=0.20"
    edge_bins[b][0 if r["result"]=="win" else 1]+=1
order=["<0","0.0-0.05","0.05-0.10","0.10-0.15","0.15-0.20",">=0.20"]
for b in order:
    if b in edge_bins:
        w,l = edge_bins[b]
        tot=w+l
        print(f"  edge {b:>10}: {w:>3}W {l:>3}L  winrate={w/tot*100:5.1f}%  (n={tot})")

# ---- Units staked bins ----
print(f"\n=== WINRATE BY UNITS STAKED BIN ===")
u_bins = defaultdict(lambda: [0,0])
for r in settled:
    u = r["units_staked"] or 0
    if u<1: b="<1.0"
    elif u<2: b="1.0-2.0"
    elif u<3: b="2.0-3.0"
    else: b=">=3.0"
    u_bins[b][0 if r["result"]=="win" else 1]+=1
for b in ["<1.0","1.0-2.0","2.0-3.0",">=3.0"]:
    if b in u_bins:
        w,l = u_bins[b]
        tot=w+l
        print(f"  units {b:>7}: {w:>3}W {l:>3}L  winrate={w/tot*100:5.1f}%  (n={tot})")

# ---- CLV analysis ----
print(f"\n=== CLV vs WIN ===")
clv_win=[]; clv_loss=[]
for r in settled:
    if r["clv"] is not None:
        (clv_win if r["result"]=="win" else clv_loss).append(r["clv"])
if clv_win: print(f"  avg CLV on WINS:   {st.mean(clv_win):+.3f} (n={len(clv_win)})")
if clv_loss: print(f"  avg CLV on LOSSES: {st.mean(clv_loss):+.3f} (n={len(clv_loss)})")

# ---- Profit ----
tot_pl = sum((r["units_pl"] or 0) for r in settled)
print(f"\n=== PROFIT ===")
print(f"  Total units P/L: {tot_pl:+.2f}")
print(f"  ROI vs stakes:   {tot_pl/sum((r['units_staked'] or 0) for r in settled)*100:+.2f}%")

# ---- Reason codes frequency on losses ----
print(f"\n=== TOP reason_codes ON LOSSES ===")
loss_codes = Counter()
for r in settled:
    if r["result"]=="loss" and r["reason_codes"]:
        try:
            for c in json.loads(r["reason_codes"]):
                loss_codes[c]+=1
        except: pass
for c,n in loss_codes.most_common(15):
    print(f"  {c}: {n}")

con.close()
