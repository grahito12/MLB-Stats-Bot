# Phase 3 Offline Analysis

**Date:** 2026-08-10  
**Status:** analysis-only — **no live model change**  
**Source:** live `data/state.sqlite` via `sqlite3` (python blocked this session)  
**Population:** `unaudited` — not promotion-eligible.

Settled moneyline ledger rows analyzed: **48**  
(Note: `reports/latest_metrics.json` reports 76 — evaluator may mix extra sources; segments below use raw `bet_ledger` only.)

---

## Phase 3.1 — Segment analysis

### Overall

| metric | value |
|--------|-------|
| n | 48 |
| wins | 22 (WR **45.8%**) |
| stake / P&L | 171.4 u / **−30.38 u** |
| ROI | **−17.7%** |
| avg edge | 8.31% |
| avg model_prob | 56.7% (range 40–61) |
| avg CLV | **−0.635** (coverage ~48) |

### By side

| side | n | WR | ROI | P&L | avg CLV |
|------|---|----|-----|-----|---------|
| away | 43 | 41.9% | **−26.3%** | −41.7 | −0.633 |
| home | 5 | 80.0% | +89.1% | +11.3 | −0.66 |

Away-heavy sample. Home n=5 too small for claim.

### By edge

| bucket | n | WR | ROI | P&L | avg CLV |
|--------|---|----|-----|-----|---------|
| edge:&lt;5 | 7 | 57.1% | +13.0% | +1.6 | −0.557 |
| edge:5-8 | 21 | 52.4% | +2.0% | +1.2 | −0.895 |
| edge:8-12 | 13 | 46.2% | −4.0% | −2.2 | −0.346 |
| edge:12+ | 7 | **14.3%** | **−71.4%** | −31.0 | −0.471 |

**Higher edge worse.** Confirms edge non-predictive; 12%+ is disaster.

### Side × edge

| | n | WR | ROI | P&L |
|--|---|----|-----|-----|
| away edge:&lt;5 | 6 | 66.7% | +29.9% | +3.2 |
| away edge:5-8 | 17 | 41.2% | −23.8% | −11.7 |
| away edge:8-12 | 13 | 46.2% | −4.0% | −2.2 |
| away edge:12+ | 7 | 14.3% | −71.4% | −31.0 |
| home edge:&lt;5 | 1 | 0% | −100% | −1.6 |
| home edge:5-8 | 4 | 100% | +116% | +12.9 |

Bleed = away + high edge.

### By odds

| bucket | n | WR | ROI | P&L | avg CLV |
|--------|---|----|-----|-----|---------|
| dog (&gt;0) | 22 | 50.0% | −13.2% | −12.4 | +0.15 |
| fav (−160..−110] | 17 | 47.1% | −13.2% | −7.0 | −1.08 |
| shortfav (−110..0] | 9 | 33.3% | −45.3% | −10.9 | −1.72 |

All odds sides lose; short fav worst. Dog CLV slightly positive but ROI still red.

### By model_prob (selected side %)

| bucket | n | WR | ROI | P&L | pred | actual |
|--------|---|----|-----|-----|------|--------|
| &lt;55 | 15 | 60.0% | **+31.5%** | +10.6 | 51.1 | 60.0 |
| 55-60 | 29 | 37.9% | **−31.2%** | −38.7 | 59.0 | 37.9 |
| 60-65 | 4 | 50.0% | −16.0% | −2.2 | 61.0 | 50.0 |

**Overconfidence at 55-60** (pred 59, actual 38). Lower-prob band better — selection/odds mix, not sharp model.

### By month

| month | n | WR | ROI | P&L | avg CLV |
|-------|---|----|-----|-----|---------|
| (empty date_ymd) | 39 | 38.5% | −29.1% | −43.8 | −0.546 |
| 2026-07 | 9 | 77.8% | +65.0% | +13.5 | −1.022 |

Most rows missing `date_ymd` (provenance gap). July small + lucky WR but still **negative CLV**.

### 3.1 conclusion

- Away + high-edge = main bleed.
- Edge floor raise alone insufficient; high edge hurts.
- CLV negative across almost every cut → Phase 2 CLV gate freeze justified.
- n small; no segment promotion claim.

---

## Phase 3.2 — Calibration

### Current map (4 points)

```
[0.4980 → 0.3889]
[0.5229 → 0.5364]
[0.5877 → 0.5572]
[0.6987 → 0.6000]
```

### Ledger calibration bins (VALUE-selected, biased)

| bin | n | pred% | actual% | err |
|-----|---|-------|---------|-----|
| 40-45 | 2 | 40.5 | 0.0 | −40.5 |
| 45-50 | 2 | 47.0 | 100.0 | +53.0 |
| 50-55 | 11 | 53.8 | 63.6 | +9.8 |
| 55-60 | 29 | 59.0 | 37.9 | **−21.0** |
| 60-65 | 4 | 61.0 | 50.0 | −11.0 |

Brier model_prob: **0.2647** (n=48)  
Brier fair_prob: **0.2448** (n=48) — market better.

### Proposed denser map (ledger only — DO NOT PROMOTE)

From bins n≥3:

```
[0.5384, 0.6364]  # n=11
[0.5896, 0.3793]  # n=29  ← overconfident core
[0.6100, 0.5000]  # n=4
```

**Reject auto-promote:** VALUE-only sample, n=48, selection bias, contradicts full-train map shape at mid band. Rebuild must use full `prediction_outcomes.csv` chronological holdout.

### Proposal

1. Keep current 4-point map live.
2. Offline rebuild from full outcomes (not ledger VALUE).
3. Gate: holdout Brier ≤ current + no ECE regression.
4. Expect high-conf ceiling ~0.60 to remain if signal weak.

---

## Phase 3.3 — Market blend Brier sweep

Formula: `(1-w)*model + w*fair` on settled ledger n=48.

| weight | Brier |
|--------|-------|
| w=0 model | **0.2647** |
| w=0.1 | 0.2620 |
| w=0.2 | 0.2595 |
| w=0.22 | 0.2590 |
| w=0.3 | 0.2571 |
| w=0.5 | 0.2528 |
| w=1 fair | **0.2448** (best) |

Monotone: **more market → better Brier**. Best offline w = 1.0 (pure fair).  
That is **not** an edge — you are copying market.

### Decision

- Residual weight **stay 0** for VALUE.
- Do not raise `moneylineMarketResidualWeight` on Brier alone.
- Only revisit if walk-forward shows ROI **and** CLV not worse vs pure model.

---

## Phase 3.4 — LLM A/B

| check | result |
|-------|--------|
| picks with `agentShift` key text | 3044 (almost all `"agentShift":null`) |
| samples inspected | `"agentShift":null` |
| applied probability shifts | **0** (null, not applied) |
| `llm_value_eval` pairs expected | **0** → `status: no_data` |

LLM probability nudge remains explanation-only. No A/B data. Keep off.

---

## Phase 3 decisions (STOP)

| item | action | promote? |
|------|--------|----------|
| segments | inform only; Phase 2 freeze stands | n/a |
| calibration denser map | proposal only | **NO** |
| market residual weight | keep 0 | **NO** |
| LLM nudge | keep off | **NO** |
| live code change | **none** | — |

### Honest bottom line

Ledger 48 settled ML: WR 45.8%, ROI −17.7%, avg CLV −0.635, Brier trails fair by 0.020.  
Worst cut: away edge 12%+ (ROI −71%).  
Phase 1 integrity + Phase 2 selection freeze stand.  
**No safe Phase 3 live model change.**

Next lever: discriminative model (AUC≫0.53) + more settled CLV under gates — not map massage, blend, or LLM nudge.

---

*Not a profitability claim. Population: unaudited.*
