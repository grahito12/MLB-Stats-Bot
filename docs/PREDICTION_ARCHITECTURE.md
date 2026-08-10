# Prediction Architecture

**Status:** canonical moneyline core + recompute replay active (2026-07-28); totals remain a separate path (no live JS pure-core); YRFI/NRFI removed (no edge, was advisory-only). Phase 1 integrity (2026-08): picks append-only via `prediction_run_id` + `pick_processing`; CLV/P&L share ledger side (`src/clv_side.js`). Phase 2 selection (2026-08): moneyline edge floor default **5%** (`MINIMUM_MONEYLINE_EDGE=0.05`); rolling avg CLV gate + `/ledger` report (`src/clv_gate.js`) — selection only, no model-prob massage.

## Canonical production path (Telegram)

```text
getMlbPredictions (src/mlb.js)
  -> fetch point-in-time features and construct coreInputs
  -> predictGameMoneylineCore (pure, deterministic, no I/O)
  -> attach odds / line snapshots
  -> attachMarketContext (market-informed display only; pure model remains authoritative for value)
  -> optional attachNewsContext (timestamped Tier-3 display context; no probability/core-input impact)
  -> applyMoneylineValueMarket
  -> attachAgentAnalyses (explanation-only; cannot change pick/prob/edge/status)
  -> storage.savePredictions (immutable snapshot + compatibility pick cache)
  -> recordBet for VALUE only

`prediction.coreInputs` is serialized into the immutable snapshot. The exact
calibration artifact is frozen alongside it, so later replay does not read
current APIs, odds, configuration, or calibration files.
```

Post-game:

```text
evaluatePostGames
  -> CLV from ledger/value side
  -> processPostGameOutcome (outcome -> settle -> mark processed)
  -> calibration proposal only (no auto-promote)
```

## Target path

```text
source observation
  -> point-in-time feature snapshot
  -> pure deterministic JS core (network/wall-clock free)
  -> immutable prediction_run + prediction_decision
  -> optional execution
  -> outcome + idempotent settlement
  -> outbox / evaluation
```

## Probability stages (intended)

```text
raw model
  -> deterministic baseball/context adjustments
  -> final calibration (artifact-bound)
  -> market comparison / edge
  -> bet qualification / stake
```

LLM may only add supporting/counter factors, data-quality warnings, market disagreement, and explanation text.

## Live vs backtest

| Path | Role |
|------|------|
| `src/core/prediction_core.js` | Canonical pure moneyline production calculation |
| `src/mlb.js` + `src/index.js` | Network adapters, live orchestration, market context, Telegram |
| Python `backtest.py` / sample pipeline | Fixture/regression only — **not** production replay |
| `prediction_snapshot` / `prediction_serializer` / `prediction_replay` | Immutable input freeze + real pure-core recompute parity |
| `scripts/replay_prediction.js` | CLI replay; non-zero on parity failure |

Replay mode is `recompute` when `coreInputs` and a frozen calibration artifact
are present. Legacy snapshots are `projection` only and are never
promotion-eligible. Python backtest ROI remains sample-only until it consumes
production-replay snapshots.

## Related

- `docs/TECHNICAL_AUDIT.md`
- `docs/DATA_LEAKAGE_POLICY.md`
- `docs/BETTING_LEDGER.md`
- `docs/EVALUATION_METHOD.md`
