# Evaluation Method

**Status:** correctness metrics and same-period market baselines active; production-replay promotion remains gated
**Do not claim profitability** unless a report is labeled `production_replay` and leakage-safe.

## 1. Principles

1. Chronological evaluation only — no random train/test splits for time-dependent data.
2. ROI = `sum(profit_loss) / sum(units_staked)` (stake-weighted). Never profit / bet count when stakes vary.
3. Missing edge/CLV excluded from averages (not coerced to 0).
4. Empty samples → metrics are `null` / unavailable, not `0.0`.
5. CLV and P/L must use the same immutable value-bet side.
6. Walk-forward test windows are half-open `[start, end)` and disjoint.
7. Predictor failures must be visible (not silently empty folds).

## 2. Populations

| Label | Meaning | Usable for promotion? |
|-------|---------|------------------------|
| `unaudited` | Live SQLite dump without full provenance | No |
| `partial` | Some identity/cutoff missing | No |
| `sample_only` | Fixture CSV / Python sample model | No |
| `production_replay` | Immutable snapshot + JS core replay | Yes (with gates) |

## 3. Walk-forward

- Expanding train window up to day before test.
- Test interval half-open; no shared test days across folds.
- Minimum train size gate before scoring.
- Report per-fold and overall accuracy, stake-weighted ROI, Brier when available.

## 4. Calibration

- Fit chronological out-of-fold only.
- Bind runtime to artifact identity (hash, cutoff, method).
- **No automatic promotion** after settled bets — proposal/outbox only.
- Calibration is the final probability stage before market edge.

## 5. Required report fields

Sample size, period, qualified bets, accuracy, log loss, Brier, ECE/MCE (when available), ROI stake-weighted, average odds/edge (coverage), CLV (coverage), drawdown, profit factor, streaks, segment breakdowns, uncertainty, git/model/calibration versions, exclusions.

## 6. Baselines

`src/evaluate.py` now reports same-period no-vig market baselines for comparable
moneyline rows: market favorite accuracy, market Brier/log loss, and
model-minus-market improvements. Current SQLite output remains labeled
`unaudited` because its historical feature provenance is incomplete.

The following promotion baselines remain blocked until a sufficiently large
`production_replay` population exists: always home, regularized logistic,
current rule model, improved model, and market residual. All must use the same
chronological snapshots and prediction timing.

Current report command:

```bash
python3 -m src.evaluate --sqlite data/state.sqlite --market all \
  --json reports/latest_metrics.json --report
```

`reports/latest_metrics.json` binds `git_sha`, `dataset_hash`, row count, and
UTC generation time. ROI is `sum(profit_loss) / sum(units_staked)`; when stake
is unavailable it is `null`, while `units_per_bet` is reported separately.

## 7. Related docs

- `docs/CURRENT_MODEL_FORMULA.md` — exact core equations
- `docs/PREDICTION_ENGINE_AUDIT.md` — calibration/evaluation selection bias, P0–P7 status
- `docs/TECHNICAL_AUDIT.md`
- `docs/DATA_LEAKAGE_POLICY.md`
- `docs/MODEL_CARD.md`
- `reports/latest_evaluation.md` (currently `unaudited`)
