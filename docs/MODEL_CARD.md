# Model Card And Backtest Template

This document is a credibility template. Do not fill in performance numbers unless they come from a reproducible backtest or settled prediction log.

## Model Purpose

The project estimates MLB pre-game probabilities and leans for:

- Moneyline winner (primary market).
- Total runs / over-under lean (secondary path; not the promotion focus).

**YRFI/NRFI removed (2026-08):** First-inning-run prediction was retired after
historical analysis showed no per-game edge (near-zero correlation with
outcomes; severe overconfidence in high probability bins). The market had
already been advisory-only (`YRFI_ACTIVE` off by default). Scope is now
moneyline model-pick only.

The output is for analysis and education. It is not guaranteed betting advice.

## Operating posture (2026-08)

- **No edge claim.** Ledger/evaluate still show model trailing no-vig market
  on broad evaluation, even though recent odds-available slices show strong
  directional accuracy.
- **Selection is conservative research mode:** existing hard NO_BET guardrails
  stay; empirical “value profile” gates stay **off** until holdout proves them.
- **Market-anchored residual:** VALUE grading can borrow a small amount of
  no-vig market probability via `MONEYLINE_MARKET_RESIDUAL_WEIGHT`. Default is
  **0**; only raise it when `npm run model` shows walk-forward gains.
- **Disagreement bypass:** `js.disagreement_away` relaxes edge/conviction floors
  and applies a **1.5x Kelly sizing boost** when model picks away but market
  favors home — the validated asymmetric edge (WR 89%, ROI 90%, n=183). Only
  this direction is promoted; the reverse is not (train WR 44%).
- **Team advantage:** `npm run model` now also generates
  `data/team_advantages.json` — per-team S/A/B/C/D tiers from WR, ROI,
  disagreement performance, and side breakdown. Use it to filter picks: only
  bet teams with tier B or higher, and prefer teams with strong away-disagreement
  records.
- **Multi-factor confidence:** `confidence_signals.js` scores SP season/recent,
  offense, form (on-fire), bullpen, lineup, injury IL, H2H, platoon, fatigue.
  Levels: rendah / sedang / tinggi / elite. Blocks VALUE below `sedang`
  (`js.factor_confidence`) unless disagreement-away bypass is active. Stake
  multiplies 0.75x–1.25x by factor quality. All signals from free MLB StatsAPI
  data already in the model — no paid player APIs.
- **RSS news veto:** optional free feeds (MLBTR/CBS/BA). Keyword flags may force
  VALUE→NO BET (SP scratch, IL, opener, postpone). Never changes probability or
  stake. No X scraping. `NEWS_RISK_VETO=true` by default when news is enabled.
- **Promotion bar for any new filter or weight:** pre-registered holdout, n
  large enough, WR above odds break-even, non-negative ROI — not in-sample
  mining alone.
- **Modeling priority** over more selection rules: improve rank-order vs market
  before adding edge slices.

## Data Sources

- MLB StatsAPI schedule, game, venue, probable pitcher, standings, and boxscore context.
- Optional odds provider through `ODDS_API_KEY` or `THE_ODDS_API_KEY`.
- Optional weather provider through `OPENWEATHER_API_KEY`.
- Local sample CSVs in `data/`.
- Persisted bot memory and settled outcomes in `data/state.sqlite` and `data/evolution/`.

## Features Used

- Team offensive and pitching context.
- Starting pitcher stats and recent form.
- Bullpen usage/fatigue.
- Home/away splits and recent form.
- Park factors.
- Weather context when available.
- Market implied probability and line movement when available.
- Lineup status and probable pitcher status.
- Historical memory and audit lessons when enabled.

## Prediction Output Contract

Every betting-facing output should separate:

- Prediction.
- Lean.
- Value.
- No Bet.
- Data Quality.
- Confidence.
- Risk warning.

## Known Limitations

- MLB lineups and pitcher roles can change close to first pitch.
- Odds, weather, injury, and lineup feeds may be missing or stale.
- Optional LLM analysis can summarize context but should not override hard no-bet guardrails.
- Small samples can make ROI, CLV, and confidence buckets misleading.
- Backtests on sample CSVs may not represent live-market performance.

## Calibration Method

The live JavaScript path applies the market-specific artifact loaded from
`data/calibration_maps.json` and `data/calibration_meta.json`. New live
prediction snapshots persist:

- `calibration_version`
- calibration artifact hash
- artifact mode (`map`, `map_low_sample_shrink`, `shrink_toward_50`, or explicit `identity`)
- sample count and warning state

Calibration is intended to be fit chronologically out-of-fold. Automatic
post-settlement retraining is **proposal-only** and cannot promote an artifact.
The current moneyline maps are sparse, so they are not evidence of robust OOS
calibration by themselves. YRFI calibration maps are no longer trained or applied.

## Backtest Report

The canonical report command is:

```bash
npm run evaluate:artifacts
```

The current report is intentionally labelled `unaudited` or `partial` until
full production snapshot replay and provenance gates pass. Current artifacts:

- `reports/latest_metrics.json`
- `reports/latest_evaluation.md`
- `reports/quarantine_inventory.json`

No performance numbers are filled here as validated model performance. The
legacy SQLite ledger contains descriptive settled rows but historical rows may
lack original prediction timestamp, quote/book identity, and exact probability
stage.

Required report fields once the production replay gate passes:

- Period and population label.
- Market and sample size.
- Brier, log loss, ECE/MCE.
- Stake-weighted ROI, drawdown, profit factor, losing streak.
- CLV with coverage and quote timing.
- Baselines and chronological walk-forward/untouched test period.
- Data exclusions, quarantine counts, and artifact/version hashes.

## Segment Checks

Segment reports are blocked until the same immutable snapshot population is
used for every segment. Planned segments:

- Moneyline by confidence bucket and edge bucket.
- Totals by market total range.
- Data quality / lineup confirmation.
- Stale or missing odds exclusions.
- Projected vs confirmed lineups.
- Month or season phase.

Missing segment data must be reported as unavailable, never as zero performance.

## Risk And Staking Policy

Default policy:

- Flat stake mode: 1 unit.
- Optional fractional Kelly mode: off by default unless explicitly configured.
- Max stake: 1 unit per pick by default.
- Max daily exposure: 3 units by default.
- Max pick confidence cap: 64% for staking context by default.
- No bet when data quality is below threshold.
- No bet when required lineup, pitcher, or odds data is stale.

## When Users Should Ignore A Prediction

Ignore or downgrade a prediction when:

- Probable pitchers are missing, projected, scratched, or stale.
- Lineups are not confirmed close to game time.
- Odds are unavailable or stale.
- Weather is stale for an outdoor game.
- The model edge is below the configured threshold.
- The dashboard marks data quality below the threshold.
- The pick conflicts with late injury/news or major line movement that the model has not absorbed.
- You cannot verify the current market price.

## Reproducibility

Record the following with every published report:

- Git commit SHA.
- Data snapshot date/time.
- Backtest command.
- Environment variables that affect behavior, excluding secrets.
- Active prompt/rule/weight versions from `data/evolution/`.

## Related

- `docs/CURRENT_MODEL_FORMULA.md` — exact core equations, coefficients, clamps, defaults
- `docs/PREDICTION_ENGINE_AUDIT.md` — P0 correctness status, model identity, calibration integrity
