# Prediction Audit Card

The Prediction Audit Card lets anyone inspect one immutable prediction and answer:
what did the system know at that moment, which model/version produced the
probability, why did it decide BET/NO BET, and what happened afterwards.

## Where

- **Dashboard**: `Audit` tab in the React dashboard (`dashboard-react`).
  Pick a prediction from the immutable history table; the card renders below it.
- **Telegram**: `/auditcard` — one command for everything:
  - `/auditcard` — list of latest immutable predictions (one row per game).
  - `/auditcard YYYY-MM-DD` — list for that date.
  - `/auditcard TEAM` (name/abbr, optionally + date), a `game_pk`, or a full
    `mp-...` prediction id — renders the full text audit card: model+versions,
    raw vs calibrated vs market no-vig probabilities, model−market delta,
    BET/NO BET + reasons, exact feature contributions, data quality,
    result + closing line + ledger CLV, and reproducibility identity.
  - Implementation: `src/auditCard.js` (JS port of the same read paths as
    `src/prediction_audit.py`, over the bot's live sqlite handle; read-only).
    Tests: `tests/test_audit_card.js`.
- **API**:
  - `GET /api/predictions/audit?date=YYYY-MM-DD&limit=N` — list immutable
    `model_predictions` rows for the selector (joined with `picks` for the
    matchup label and `game_outcomes` for settled state).
  - `GET /api/predictions/{prediction_id}/audit` — normalized audit payload:
    `prediction`, `model`, `probabilities`, `decision`, `market`, `dataQuality`,
    `contributions`, `result`, `ledger`, `replay`. 404 for unknown ids.
- **Backend module**: `src/prediction_audit.py` (read-only over
  `data/state.sqlite`). The frontend never reconstructs prediction logic.

## Data sources (all pre-existing, nothing is recomputed)

| Section | Source |
| --- | --- |
| Identity, versions, probability stages | `model_predictions` (migration 006) |
| Snapshot path, run metadata | `prediction_runs` + payload |
| Matchup, bet decision detail, prediction quality | `picks` payload (same run_id) |
| Market at prediction / opening / closing | `market_quote_pairs` |
| Settlement | `game_outcomes`, `bet_ledger` |

## Guarantees

- **No fabrication.** A field that was not persisted for a prediction renders
  as "Not recorded". Missing snapshot files are reported as missing.
- **Temporal safety.** "Market at prediction" only ever uses a quote pair with
  `fetched_at_utc <= as_of_utc`. A paired quote that violates this (or a
  missing pairing) falls back to the nearest pre-`as_of` eligible quote, and
  the card labels the fallback. Closing quotes are shown separately and used
  for evaluation/CLV only.
- **Probability stages stay distinct.** Raw model, calibrated (final), display,
  and market no-vig probabilities are separate fields, never blended.
- **Exact contributions.** Feature contributions for `heuristic_v1` are the
  persisted `modelBreakdown` components of the actual production formula
  (`predictGameMoneylineCore`); they sum to `rawEdge` exactly and the payload
  carries a `decomposition_complete` flag that is verified, not assumed. The
  record-context group (log5/form/h2h/memory/platoon) carries the 0.45
  dampening when `recordDominated` was true. "Probability points" are a
  linearized approximation around the dampened edge and are labeled as such.
  The normalized format (`feature`, `category`, `value`, `edge_contribution`,
  `probability_points`) is model-agnostic so learned models can later plug in
  coefficient/SHAP-based explanations.

## Tests

`tests/test_prediction_audit.py` — fixtures apply the real migration SQL
(002 + 006), then cover: listing/filtering, 404s, probability-stage
separation, the market temporal guard (including a paired quote that violates
`as_of` being rejected), decision reasons, settlement correctness, explicit
missing/fallback data-quality states, missing-snapshot reporting, and the
contribution decomposition (component sum == rawEdge, record-dominated 0.45).
