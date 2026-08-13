# Data Leakage Policy

**Status:** hard temporal validator active for snapshot validation; source adapters remain partially date-granular
**Internal time base:** UTC  
**Display timezone:** configured bot timezone only for UI

This policy defines what may enter a prediction. A lower honest out-of-sample score is preferred over any result that uses future information.

## 1. Point-in-time contract

Every pregame prediction should carry:

| Field | Meaning |
|-------|---------|
| `prediction_timestamp_utc` | When the decision was produced |
| `as_of_utc` / `as_of_date` | Cutoff for feature eligibility |
| `first_pitch_utc` | Scheduled first pitch |

Every feature/quote should carry when available:

- `source`
- `query_cutoff` / `as_of`
- `observed_at` / `effective_at` / `fetched_at`
- eligibility status
- payload hash (when stored)

### Eligibility rule (pregame)

```text
observed_at / effective_at  <=  as_of  <=  first_pitch
```

(with a small clock-skew allowance; default 2 minutes)

### Freshness statuses

| Status | Meaning |
|--------|---------|
| `fresh` | within max age and not future |
| `stale` | older than max age |
| `missing` | no timestamp |
| `invalid_future` | timestamp after now (+skew) — **never** treat as fresh |

Helpers: `src/temporal_contract.js`, `src/temporal_contract.py`, `src/data_freshness.py`.

## 2. Source rules

| Source | Cutoff rule | Current enforcement |
|--------|-------------|---------------------|
| Schedule / standings (date params) | date ≤ as_of date | Partial (date-level) |
| Rolling team stats / recent games / bullpen / fatigue / H2H / injury | date-bounded APIs | Prefer these paths |
| Full-season `teams/stats` | season-to-date via byDateRange when as_of provided | **Enforced** in live `getMlbPredictions` (`fetchTeamStats(season, dateYmd)`) |
| Pitcher season stats | season-to-date via byDateRange when as_of provided | **Enforced** (`fetchPitcherStats(..., dateYmd)`) |
| Pitcher gameLog recent starts | only starts with `date < as_of_date` | **Enforced** in `fetchPitcherRecentStarts` |
| Boxscore lineup | only immutable pregame capture | Historical boxscore can leak actual lineup — do not use for backtest without snapshot |
| Odds quotes | last eligible pre-first-pitch | Opening freeze partial; close capture must not overwrite post-start |
| Weather | observation ≤ as_of | Live fetch; fixtures must be labeled sample |
| Static sample CSVs | never "live fresh" | Label fixture/sample |
| External news/articles | explicit availability ≤ decision cutoff; post-start excluded | live filter active; published-only records remain unverified |

## 3. Forbidden practices

1. Using full-season aggregates that include games after the prediction date in any **historical evaluation**.
2. Taking `.slice(-N)` on a full season log without filtering by as_of.
3. Treating future `fetchedAt` as age 0 / fresh.
4. Classifying in-play games as "final pregame" tier solely because `hoursToGame` was clamped at 0.
5. Stamping fixture data with wall-clock "now" so it looks live.
6. De-vigging independently shopped home/away books as one same-book market for "fair" probability without labeling synthetic.
   - **Enforced:** fair de-vig only when side books match (or legacy single `moneylineBook`); otherwise edge uses raw implied executable price and side-specific book.
7. Applying a calibration map fitted on future outcomes to past predictions without chronological OOF discipline.

## 4. Missingness

- Missing timestamp → `missing`, not fresh.
- Missing as_of for historical-style recent form → **empty feature**, not full-season fallback.
- Missing book/quote identity → quarantine for CLV-sensitive metrics.

## 5. Same-book vs best executable

- **Fair market construction:** same-book paired lines when possible.
- **Executable price:** side-specific best odds + bookmaker id.
- Do not silently mix the two.

## 6. Closing line

- Close = last eligible quote with `observed_at <= first_pitch`.
- Post-start polls must not overwrite an established close.
- CLV side must match immutable value-bet side (ledger), not display pick.

## 7. Evaluation labeling

| Label | When |
|-------|------|
| `unaudited` | Phase 0 baseline / mixed live dumps |
| `partial` | Some provenance missing |
| `sample_only` | Fixture CSV backtests |
| `production_replay` | Snapshot replay of live JS core with cutoff-safe features |

Do not promote models on `unaudited` or `sample_only` ROI.

## 8. Remaining leakage risks (honest)

Still open after Phase 2 partial:

- Season team/pitcher aggregates without date reconstruction.
- Boxscore lineup path for non-live historical use.
- Timestamp-level (not only date-level) enforcement on all adapters.
- Append-only market observations vs mutable `line_snapshots`.
- Python backtest still not production JS replay.

See `docs/TECHNICAL_AUDIT.md` and `docs/REMAINING_RISKS.md` (when published).
