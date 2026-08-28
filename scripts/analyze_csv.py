#!/usr/bin/env python3
"""Edge analysis from predictions_log_live.csv (settled picks truth source)."""
import csv, statistics as st
from collections import defaultdict, Counter

PATH = "/root/MLB-Stats-Bot/data/predictions_log_live.csv"

rows = []
with open(PATH) as f:
    for r in csv.DictReader(f):
        rows.append(r)
print(f"TOTAL rows: {len(rows)}")

# Normalize
def fnum(x, d=0.0):
    try: return float(x)
    except: return d

settled = [r for r in rows if r["result"] in ("win","loss","push")]
print(f"Settled: {len(settled)}  (win={sum(1 for r in settled if r['result']=='win')}, "
      f"loss={sum(1 for r in settled if r['result']=='loss')}, "
      f"push={sum(1 for r in settled if r['result']=='push')})")

# dates range
dates = sorted(set(r["date"] for r in settled))
print(f"Date range: {dates[0]} -> {dates[-1]}  ({len(dates)} days)")

# ---- Overall
W = sum(1 for r in settled if r["result"]=="win")
L = sum(1 for r in settled if r["result"]=="loss")
print(f"\n=== OVERALL ===  winrate={W/(W+L)*100:.1f}%  (W{W}/L{L})")

# ---- Daily
by_day = defaultdict(lambda:[0,0,0])
for r in settled:
    d=r["date"]
    by_day[d][0 if r["result"]=="win" else (1 if r["result"]=="loss" else 2)]+=1
print(f"\n=== DAILY WINRATE ===")
rates=[]
for d in dates:
    w,l,p=by_day[d]; tot=w+l
    rate = w/tot*100 if tot else 0
    rates.append(rate)
    bar = "#"*int(rate/2)
    print(f"{d}: {w:>2}W {l:>2}L {p:>1}P  {rate:5.1f}%  n={tot:>2} {bar}")
print(f"\nmean={st.mean(rates):.1f}% median={st.median(rates):.1f}% min={min(rates):.1f}% max={max(rates):.1f}% stdev={st.pstdev(rates):.1f}")
above=sum(1 for x in rates if x>50); below=sum(1 for x in rates if x<50)
print(f">50%: {above} days   <50%: {below} days   =50%: {len(rates)-above-below}")

# ---- By market type
print(f"\n=== BY MARKET TYPE ===")
by_mkt=defaultdict(lambda:[0,0])
for r in settled:
    w = 1 if r["result"]=="win" else 0
    by_mkt[r["market_type"]][w]+=1
    by_mkt[r["market_type"]][1]+=0 if r["result"]=="win" else 1
for m,(w,l) in by_mkt.items():
    tot=w+l
    print(f"  {m:>12}: {w:>3}W {l:>3}L  {w/tot*100:5.1f}%  (n={tot})")

# ---- By edge bin
print(f"\n=== BY EDGE BIN ===")
edge_bins=defaultdict(lambda:[0,0])
for r in settled:
    e=fnum(r["edge"])
    if e<0.05: b="<0.05"
    elif e<0.10: b="0.05-0.10"
    elif e<0.15: b="0.10-0.15"
    elif e<0.20: b="0.15-0.20"
    else: b=">=0.20"
    edge_bins[b][0 if r["result"]=="win" else 1]+=1
for b in ["<0.05","0.05-0.10","0.10-0.15","0.15-0.20",">=0.20"]:
    if b in edge_bins:
        w,l=edge_bins[b]; tot=w+l
        print(f"  edge {b:>10}: {w:>3}W {l:>3}L  {w/tot*100:5.1f}%  (n={tot})")

# ---- By confidence
print(f"\n=== BY CONFIDENCE ===")
conf_bins=defaultdict(lambda:[0,0])
for r in settled:
    c=fnum(r["confidence"])
    if c<0.55: b="<0.55"
    elif c<0.65: b="0.55-0.65"
    elif c<0.75: b="0.65-0.75"
    else: b=">=0.75"
    conf_bins[b][0 if r["result"]=="win" else 1]+=1
for b in ["<0.55","0.55-0.65","0.65-0.75",">=0.75"]:
    if b in conf_bins:
        w,l=conf_bins[b]; tot=w+l
        print(f"  conf {b:>10}: {w:>3}W {l:>3}L  {w/tot*100:5.1f}%  (n={tot})")

# ---- By units staked
print(f"\n=== BY UNITS STAKED ===")
u_bins=defaultdict(lambda:[0,0])
for r in settled:
    u=fnum(r["units_staked"])
    if u<1: b="<1.0"
    elif u<2: b="1.0-2.0"
    elif u<3: b="2.0-3.0"
    else: b=">=3.0"
    u_bins[b][0 if r["result"]=="win" else 1]+=1
for b in ["<1.0","1.0-2.0","2.0-3.0",">=3.0"]:
    if b in u_bins:
        w,l=u_bins[b]; tot=w+l
        print(f"  units {b:>7}: {w:>3}W {l:>3}L  {w/tot*100:5.1f}%  (n={tot})")

# ---- Profit
tot_pl=sum(fnum(r["profit_loss"]) for r in settled)
tot_stake=sum(fnum(r["units_staked"]) for r in settled)
print(f"\n=== PROFIT ===")
print(f"  Total P/L: {tot_pl:+.2f} units")
print(f"  Total staked: {tot_stake:.2f}")
print(f"  ROI: {tot_pl/tot_stake*100:+.2f}%")

# ---- Daily P/L to find variance source
print(f"\n=== DAILY P/L (variance driver) ===")
by_day_pl=defaultdict(float)
for r in settled:
    by_day_pl[r["date"]]+=fnum(r["profit_loss"])
worst=sorted(by_day_pl.items(), key=lambda x:x[1])[:5]
best=sorted(by_day_pl.items(), key=lambda x:-x[1])[:5]
print("  Worst days:")
for d,pl in worst: print(f"    {d}: {pl:+.2f}")
print("  Best days:")
for d,pl in best: print(f"    {d}: {pl:+.2f}")
