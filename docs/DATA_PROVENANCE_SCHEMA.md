# Data Provenance Schema

**Status:** enforced for promotion-eligible evaluation via `src/data/temporal_validator.js`
**Time base:** UTC

Every feature that feeds a prediction must carry explicit provenance so a
historical replay can prove no future information leaked in. A prediction with
incomplete provenance is **live-safe** at best and is **never promotion-eligible**.

## 1. Timestamp definitions

| Field | Meaning |
|-------|---------|
| `observedAt` | When the underlying event/statistic occurred. |
| `availableAt` | When the information became available to the prediction system. |
| `fetchedAt` | When the system retrieved it. |
| `asOf` | The maximum permitted information timestamp for this prediction. |
| `predictionTimestampUtc` | When the decision was produced. |
| `firstPitchUtc` | Scheduled first pitch. |

## 2. Eligibility rule

```text
feature.availableAt <= predictionTimestamp   (within clock skew, default 2 min)
observedAt / effectiveAt <= asOf <= firstPitch
```

A violation raises `TemporalLeakageError` (strict mode) or is recorded as a
machine-readable error. The validator never silently passes a future feature.

## 3. Provenance record

```javascript
{
  value,              // the feature value
  source,             // e.g. 'mlb_statsapi', 'odds_api', 'weather'
  observedAt,         // ISO UTC or null
  availableAt,        // ISO UTC or null
  fetchedAt,          // ISO UTC or null
  inferred,           // true if any timestamp was inferred (not measured)
  quality,            // optional data-quality label
  historicalValidity  // 'verified' | 'historical_unverified' | 'sample'
}
```

## 4. Classification (from `classifyFeatureProvenance`)

| Status | liveSafe | promotionSafe | Trigger |
|--------|----------|---------------|---------|
| `verified` | yes | yes | explicit `availableAt <= predictionTimestamp` |
| `historical_unverified` | yes | no | only `observedAt`/`fetchedAt`, no explicit `availableAt` |
| `inferred_timestamp` | yes | no | `inferred: true` |
| `missing_timestamp` | no | no | no timestamps at all |
| `future` | no | no | `availableAt > predictionTimestamp` (+skew) |

## 5. Error codes (`TEMPORAL_CODES`)

- `future_feature` — feature timestamp after the prediction cutoff
- `available_after_prediction` — availability after the prediction time
- `missing_timestamp` — no usable timestamp
- `inferred_timestamp` — timestamp was inferred
- `unverified_historical` — availability cannot be proven
- `missing_as_of` — snapshot has no prediction timestamp / as_of
- `as_of_after_first_pitch` — prediction made after first pitch

## 6. Feature-family availability rules

| Family | Rule | Enforcement |
|--------|------|-------------|
| Team season stats | season-to-date via `byDateRange` ending `as_of_date` | enforced in live path |
| Rolling team form | `byDateRange` end `as_of_date - 1` | enforced (date-level) |
| Standings | date ≤ as_of date | partial (date-level) |
| Pitcher season stats | season-to-date via `byDateRange` | enforced |
| Pitcher recent starts | only game-log rows with `date < as_of_date` | enforced |
| Bullpen workload | games with `date < as_of_date` | enforced (date-level) |
| Injuries | transactions dated ≤ as_of date | partial |
| Lineups / batting order | only immutable pregame capture | **historical boxscore is `historical_unverified`** |
| Weather | observation ≤ as_of | live fetch; fixtures labeled `sample` |
| Market odds | last eligible quote with `observed_at <= first_pitch` | opening freeze partial |
| Opening lines | frozen at first capture | enforced (`INSERT OR IGNORE`) |
| Closing lines | last pre-first-pitch quote; never post-start overwrite | enforced for CLV |
| Model memory / evolution | only promoted artifacts | proposal-only (no auto-promote) |
| Calibration data | chronological out-of-fold only | governed (see CALIBRATION_GOVERNANCE) |
| External news/articles | `availableAt <= predictionTimestamp`; published time alone is unverified | enforced in `src/news.js`; unverified context is not promotion-safe |

## 7. Historical lineup policy

If only a final boxscore lineup exists without a trustworthy pregame
availability timestamp:

```text
lineupStatus       = historical_unverified
lineupAdjustment   = neutral
promotionEligible  = false
```

Do **not** infer a pregame lineup timestamp from the final boxscore.

## 8. External news policy

External article records use `publishedAt` as `observedAt`. Publication time alone does not prove when feed became available, so RSS/Atom records without explicit provider `availableAt` are `historical_unverified`: safe for live display, not model promotion. Only provider-stamped `availableAt <= predictionTimestampUtc` can be promotion-safe. News remains outside deterministic `coreInputs`.

## 9. Validation command

```javascript
import { validateTemporalSnapshot } from '../src/data/temporal_validator.js';
const report = validateTemporalSnapshot(snapshot, null, { strict: false });
// report.promotionEligible === false  -> exclude from model promotion
```

## 10. Related

- `docs/DATA_LEAKAGE_POLICY.md`
- `docs/REPLAY_ARCHITECTURE.md`
- `docs/CALIBRATION_GOVERNANCE.md`
