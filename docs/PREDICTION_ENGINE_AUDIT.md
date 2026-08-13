# Prediction Engine Audit

Status of the MLB winner-prediction engine as of the P0 correctness pass.
Generated from code; see `docs/CURRENT_MODEL_FORMULA.md` for exact equations.

## 1. Canonical surfaces

| Surface | Entry point | Notes |
|---|---|---|
| Telegram bot | `src/index.js` → `getMlbPredictions` (`src/mlb.js`) | polling under PM2 `mlb-bot` (Node v24.18) |
| Dashboard | `src/dashboard.js` | reads stored predictions + backtest |
| Scheduler | `src/index.js` scheduled ticks | drives `savePredictions` + postgame |
| Storage | `src/storage.js` (better-sqlite3) | immutable snapshots + compatibility cache |
| Replay | `src/prediction_replay.js` | recompute from frozen `coreInputs` |

## 2. JS / Python boundary

| Layer | Language | Role |
|---|---|---|
| Live inference | JavaScript (`src/core/prediction_core.js`) | canonical, deterministic, pure |
| Calibration application | JavaScript (`src/calibration.js`) | applies frozen artifact |
| Snapshot capture/replay | JavaScript | immutable, hash-locked |
| Offline training/evaluation | Python (`src/probability_calibrator.py`, `src/walk_forward_backtest.py`, `src/evaluate.py`) | research only; never mutates production tables |

Python trains artifacts; JavaScript applies them. A JS/Python parity contract is
required for any challenger that ships live inference.

## 3. Confirmed P0 correctness fixes

### 3.1 Team-stat parser defect (resolved)

`fetchTeamStats(...)` requests `byDateRange`/`byDateRangeAdvanced` blocks.
`teamStatBlockKind()` now accepts both `season` and `daterange` periods (basic
and advanced) and assigns each to `hitting`/`pitching`/`hittingAdvanced`/
`pitchingAdvanced`. Previously only `season`-containing blocks were assigned,
so valid season-to-date offense/pitching became `null` and the core silently
substituted symmetric defaults.

### 3.2 Prior-date aggregate cutoff

`aggregateDateRange(season, dateYmd)` returns `{startDate: <opening>,
endDate: <predictionDate - 1>}`. Returns `null` before season opening or for
invalid dates. Used by team stats, pitcher season stats, and standings so no
same-day leakage occurs.

### 3.3 H2H same-day exclusion

`summarizeHeadToHeadGames` keeps only `officialDate < predictionDate`, excludes
the current `gamePk`, non-Final states, and future games.

### 3.4 Park-factor context

`parkFactorContext` keys by `game.venue.id`, matching the core's park lookup.

### 3.5 Named probability stages

Persisted separately: `rawBaseballProbability`, `pureModelProbability`,
`marketInformedProbability`, `displayProbability`, `valueModelProbability`.
Display/market fields can no longer be evaluated as pure control output.

## 4. Model identity

```
modelId:            heuristic_v1
modelImplVersion:   moneyline-core-v1.0
featureSchemaVersion: mlb-control-features-v1.0
```

Stamped in `src/core/model_ids.js`. `test_model_ids.js` asserts the public
impl version matches `PREDICTION_CORE_MODEL_VERSION`.

## 5. Temporal contract

| Check | Rule |
|---|---|
| Pregame eligibility | `observedAt <= fetchedAt <= asOf < firstPitch` |
| Promotion-safe row | `as_of_utc < first_pitch_utc` |
| Same-day aggregate | excluded (prior-day cutoff) |
| Doubleheader | `commence_time` tiebreak in `lineMovement.js` |
| Post-pitch save | marked `INELIGIBLE_TEMPORAL`, never backdated |
| News provenance | `availableAt <= predictionTimestamp`; publication-only = `historical_unverified`, not promotion-safe |

Enforced in `src/temporal_contract.js` (`assertPregameEligible`) and
`src/data/temporal_validator.js` (`validateTemporalSnapshot`,
`classifyFeatureProvenance`). Strict mode throws `TemporalLeakageError`.

## 6. Prediction quality states

| Status | Meaning | promotionEligible |
|---|---|---|
| `OK` | all critical families present, pregame | true |
| `DEGRADED` | optional families missing, or critical missing | false if critical missing |
| `INELIGIBLE_TEMPORAL` | as-of at/after first pitch | false |

Critical families: `team_season_basic`, `standings_and_splits`,
`probable_starter_season` (identity + stats).

## 7. Availability / fallback behavior

`featureFallbackSummary` emits one structured reason per missing family.
`buildFeatureAvailability` exposes a boolean per family:

`teamSeasonBasic`, `teamSeasonAdvanced`, `standings`, `probableStarters`,
`probableStarterRecent`, `rollingTeamForm`, `bullpenFatigue`,
`scheduleFatigue`, `injuries`, `lineup`, `headToHead`, `pregame`.

Missing values stay `null` with availability/provenance; the core substitutes
documented league-average defaults (see formula doc §7). Research vectors must
not present those defaults as observed evidence.

## 8. Calibration integrity

`src/calibration.js` separates application mode from integrity status:

| Mode | Meaning |
|---|---|
| `map` | isotonic interpolation, trusted |
| `map_low_sample_shrink` | map + shrink toward 0.5, below sample floor |
| `shrink_toward_50` | no map, shrinkage only |
| `identity` | no transform |

| Integrity status | Meaning | promotionSafe |
|---|---|---|
| `active` | fully bound, hash-consistent, pure map | true |
| `stale` | validThrough expired or meta status=stale | false |
| `incompatible_version` | model/impl/schema mismatch or hash mismatch | false |
| `missing_artifact` | map missing while meta claims success | false |
| `legacy_unbound` | map present but no model bindings | false |
| `identity` | no map, no claim | false |

Bindings required for `active`: modelId, modelImplVersion, featureSchemaVersion,
population, trainingCutoff, method, datasetHash, expectedContentHash.

Artifact hash chain: `contentHash` (over normalized mapping + bindings) →
`artifactHash` (over contentHash + mode + integrity + expected identity) →
`calibrationVersion` (`cal-<market>-<artifactHash>`). `verifyCalibrationArtifact`
re-derives the full chain; any tampering produces a named reason.

Live on-disk moneyline map (1044 samples, 4 isotonic points) has no model
bindings → `legacy_unbound`, `mode=map`, `promotionSafe=false`. Numerically
active for live display; not eligible to establish challenger compatibility.

## 9. Replay integrity

`replaySnapshot` chooses mode by snapshot content:

- **recompute** — `coreInputs.game` present: re-runs `predictGameMoneylineCore`
  from frozen inputs + frozen calibration artifact, compares to stored stages.
- **projection** — no coreInputs: round-trips stored decision fields; explicitly
  labeled, never promotion-eligible.

`snapshotIntegrity` recomputes `hashPayload(body)` and rejects any snapshot
whose stored hash does not match. `replayPromotionGate` additionally calls
`verifyCalibrationArtifact` and checks actual binding fields against the
snapshot's `versions`. Promotion requires: pregame, complete model identity,
active+promotionSafe calibration, parity ok, prediction quality eligible.

## 10. Persistence gaps (P1 — resolved)

P1 added (migration 006, additive; existing tables untouched):
- `model_predictions` — append-only all-game per-model history, one row per
  (run, model). Control `heuristic_v1` writes for EVERY eligible scheduled game
  including NO BET. Outcomes stay separate labels.
- `market_quote_pairs` — immutable same-book home/away pairs with no-vig
  probabilities, overround, first-pitch guard (post-pitch = ineligible
  diagnostic only), opening/closing flags. Paired to a run only when
  `fetched_at <= as_of`.
- `game_outcomes` — idempotent all-game label table, recorded for every final
  game independent of betting.
- `model_dataset_folds` — chronological fold manifest (same-date partitioning,
  untouched holdout).
- `src/core/feature_vector.js` — stable versioned feature-vector contract from
  frozen coreInputs (values as observed or null + missingness + sample size).
- `src/dataset/build_game_dataset.py` — read-only dataset builder (one
  deterministic row per game, quarantine, folds, manifest).
- `src/eval/` — metrics (accuracy/Brier/log loss/AUC/ECE/reliability),
  baselines (home/market/elo-log5), common-intersection comparison,
  evidence-bound recommendation (KEEP V1 / RUN V2 IN SHADOW / PROMOTE / …).
- `scripts/build_game_dataset.py`, `scripts/feature_quality_report.py` — CLIs.

## 10.1 P2 learned_v2_logistic challenger (shadow-only)

P2 added a pure-baseball L2 logistic challenger, shadow-only until
chronological all-game evidence + explicit human approval:

- `src/models/train_learned_v2_logistic.py` — trains from P1 all-game feature
  vectors (excludes market, outcomes, display blend, bet status, CLV, postgame).
  Imputation medians, missingness indicators, scaling, coefficients, and L2
  strength fit INSIDE each training fold only; regularization selected via inner
  chronological validation. Emits a versioned `insufficient_data` report (no
  usable artifact) when support is below declared minimums — never a token model.
  Writes proposal artifacts to `data/models/`; never mutates production tables.
- `src/core/learned_v2_logistic.js` — deterministic pure-JS inference from the
  frozen artifact. Missing required features without declared imputation return
  `unavailable`, not a default probability. Hash-verified artifact (tamper reject).
- `src/core/model_registry.js` — shadow orchestrator. `MLB_MODEL_VERSION`
  defaults `heuristic_v1`; `MLB_SHADOW_MODE` defaults `false`. When explicitly
  true + compatible artifact present, scores `learned_v2_logistic` on the same
  frozen run and appends its row. Never mutates winner, winProbability, VALUE,
  stake, Telegram, dashboard, CLV, or model memory.
- `capturePredictionSnapshot` now persists `normalized_feature_vector`,
  `feature_hash`, `core_inputs_hash`, `feature_manifest_version` into the
  migration-006 `prediction_runs` columns (built from frozen coreInputs).
- `src/core/feature_vector_py.py` — Python mirror of the JS feature-vector
  contract for offline training/parity (JS remains canonical for live inference).

No challenger is active by default. Shadow rows carry `status='SHADOW'`,
`promotion_eligible=0`, `display_*=null`, `calibrationStatus='identity'`.
P2 gate met: shadow-off leaves control surfaces byte/semantic compatible;
shadow-on persists challenger rows or a clear unavailable reason; JS/Python
parity within 1e-6 on identical feature vectors.

## 10.2 P3 market_residual_v2 challenger (shadow-only)

P3 added a fixed-offset residual model, shadow-only until chronological
all-game evidence + explicit human approval:

- `src/models/train_market_residual_v2.py` — trains the model
  `logit(P_home) = logit(P_market_no_vig_home) + beta0 + beta·X_baseball`.
  The market-offset coefficient is FIXED at exactly 1.0 (never fit). Only
  beta0/`beta` are learned via L2-penalized Bernoulli regression; L2 strength
  selected via inner chronological validation on the offset-adjusted Brier.
  sklearn has no native offset — the market logit is added to the linear
  predictor at predict time (not fit as a feature), so its coefficient cannot
  drift. Training uses ONLY complete same-book quote pairs available by run
  `as_of`; rows without market are excluded from training and score unavailable
  at inference (never a default probability). Emits `insufficient_data` (no
  artifact) when with-market rows fall below `MIN_WITH_MARKET_ROWS=40` or fold
  support is inadequate — never a token model. Computes `market_oof_metrics`
  (no-vig market baseline on the same with-market OOF rows) for the
  incremental-over-market comparison P3/recommend.py requires. Never mutates
  production tables.
- `src/core/market_residual_v2.js` — deterministic pure-JS inference.
  `verifyMarketResidualV2Artifact` rejects an artifact whose
  `market_offset_coefficient != 1` (fixity guard) and any tampered hash.
  `scoreMarketResidualV2(artifact, flatVector, marketNoVigHomeProb)` returns
  unavailable when market prob is missing/out-of-range; else computes
  `marketLogit`, `residualLogit` (intercept + Σ coef·scaled(X)), and the
  sigmoid of their sum.
- `src/core/model_registry.js` — `scoreMarketResidualV2Shadow` resolves the
  same-book no-vig home prob from the run's frozen odds
  (`resolveSameBookNoVigHomeProb` + local `moneylineBooksAreSameLocal` mirror);
  different books or missing odds → `no_same_book_market_pair`, no residual row.
  `buildMarketResidualV2Entry` persists `residual_logit`,
  `market_no_vig_home_prob`, `market_no_vig_away_prob` alongside the
  challenger probability; `status='SHADOW'`, `promotion_eligible=0`,
  `display_*=null`. Production market display blend and
  `MONEYLINE_MARKET_RESIDUAL_WEIGHT` remain unchanged.

P3 gate met: logit-offset equation with fixed market coefficient; timestamp
pairing (quote `fetched_at <= as_of < first_pitch`); no-market → unavailable
(never default); artifact compatibility incl. offset-fixity guard; JS/Python
parity within 1e-6. No artifact/promotion claim is made — forward with-market
history must accrue before P7 can resolve it.

## 10.3 P4 timestamp-safe candidate features (shadow research only)

P4 added seven candidate feature families as a NEW versioned schema
`mlb-candidate-features-v1.0`, separate from the control
`mlb-control-features-v1.0` / `mlb-feature-vector-v1.0` 62-feature vector.
Candidate families are NOT wired into `heuristic_v1` and never run inside
`/predict` as a Python child process — they are forward-captured pregame and
extracted offline for shadow training/ablation (P5).

- `src/core/candidate_features.js` — pure payload builders + a write-once
  orchestrator. Seven families: `statcast_team` (rolling xwOBA/xSLG/barrel/
  hard-hit), `pitch_arsenal` (Stuff+ + platoon split), `expected_innings`
  (projected starter innings), `bullpen_quality` (prior-date reliever quality
  weighted by 9 − expected starter innings), `lineup_batter` (AB-weighted OPS +
  confirmation state), `bvp` (lineup-vs-starter, null below MIN_BVP_PA=50),
  `starter_xera` (contact-quality xERA proxy). Every payload carries
  `as_of_utc`/`fetched_at_utc` provenance. The orchestrator refuses to write
  when `as_of_utc >= first_pitch_utc` (post-pitch = temporally ineligible, never
  recorded as pregame). Missing local data yields null + sample size, never a
  fabricated value; league-average shrinkage happens at training time inside the
  fold. BvP events must be filtered to `game_date < predictionDate` by the
  caller (the upstream aggregator has no date cutoff of its own — leakage guard).
- `src/candidate_features.py` — offline extractor. Reads the generic
  `feature_snapshots` store and builds one `mlb-candidate-features-v1.0` vector
  per `game_pk`, re-verifying promotion-safety per family (post-pitch/missing-
  first-pitch evidence → null + temporal_rejection, never a default). Emits
  `missing_<feature>` indicators + sample sizes. `candidate_coverage_summary`
  feeds the feature-quality report. JS/Python `_stable_stringify` parity
  confirmed (identical sha256 on the same vector). Outcomes are never embedded.
- `scripts/feature_quality_report.py` — extended with a "Candidate Feature
  Families" section (distinct games + per-group snapshot counts).

P4 gate met: timestamp-safe capture (strict before-date + promotion-safety gate);
null-on-missing (no fabrication); JS/Python hash parity; candidate schema is
separate from control (heuristic_v1 coefficients unchanged); forward capture
only (0 synthesized rows). Candidate collection ships before scoring — data must
accrue before P5 ablations can retain a family.

## 10.4 P5 chronological ablations

P5 added a chronological ablation engine that scores control + full logistic +
per-family leave-one-out / family-only variants on the SAME walk-forward test
folds (never the holdout):

- `src/eval/ablation.py` — `run_ablations(db_path, family_groups=...)` builds
  the all-game dataset + folds, then for each family group fits an L2 logistic
  on (a) all 62 features [full], (b) all-minus-the-family [leave-one-out], (c)
  the family alone [family-only]. L2 imputation/scaling/coefficients fit INSIDE
  each training fold; inner chronological C selection. Metrics per variant:
  accuracy, Brier, log loss, ROC AUC, ECE, coverage. Delta Brier/log loss/
  accuracy (LOO minus full) isolates each family's incremental contribution.
  Insufficient families carry a note, never a fabricated metric. V1 control
  stored probability is the reference; ablations NEVER modify live control math
  (diagnostic leave-one-out on frozen snapshots only). Holdout never opened.
  Two schemas: `control-v1-families` (11 control families: offense/prevention/
  starter/bullpen/form/lineup/schedule/injury/h2h/weather/platoon) and
  `candidate-v1-families` (7 P4 candidate families).
- `scripts/run_ablation.py` — CLI writing machine JSON + Markdown to
  `reports/ablation/`.
- `tests/test_p5_ablation.py` (7 tests): partition invariant, control+full
  reference produced, LOO differs from full when signal present, holdout not
  opened, report round-trip, insufficient-family note.

P5 gate met: every retained/skipped family has a formal report; skipped families
+ reasons visible; holdout unopened; V1 production math unchanged. Data
limitation: production DB lacks migration 006 tables (no restart applied), so
ablation runs against a migrated copy; it correctly errors rather than fabricate
on an unmigrated DB.

## 10.5 P6 all-game OOF calibration + artifact governance

P6 added a leakage-free all-game out-of-fold calibration engine and retargeted
the PRIMARY calibration training path from selected-value history to all-game
`model_predictions` + `game_outcomes`. All proposal artifacts are write-only to
`data/models/`; live V1 calibration files are never overwritten. Activation
requires separate human approval.

- `src/eval/oof_calibration.py` — `run_oof_calibration(db_path)` generates model
  OOF probabilities on the outer walk-forward test folds. Calibrate fold k ONLY
  with eligible OOF `(raw_probability, outcome)` pairs from STRICTLY EARLIER
  folds; the first eligible fold uses identity (no earlier history). A scored
  label can therefore never enter the calibrator that calibrates it. Compares
  identity, Platt, guarded isotonic, and beta calibration prequentially on
  pre-holdout OOF. Applies predeclared minimum-sample / per-class-event /
  distinctness / monotonicity / degenerate checks; unstable methods are skipped,
  never forced into a map. Selects the deployable method by lowest pre-holdout
  prequential Brier AMONG JS-parity-capable methods only (beta has no JS
  `betaincinv` parity partner → comparison reference only, never selected). Fits
  the final proposal calibrator on ALL pre-holdout OOF pairs, then scores the
  untouched holdout ONCE. Holdout never enters any fit.
- `src/core/calibration_proposal.js` — pure-JS proposal artifact reader.
  `verifyOofCalibrationArtifact` enforces model_id, manifest version, method
  (deployable only), dataset_hash, training_cutoff, sample_count, and a
  re-derived artifact hash (tamper reject). Nonpositive Platt slope, non-
  monotonic isotonic map, missing params, and beta method are all rejected.
  `applyOofCalibration` applies identity / Platt / isotonic_guarded with frozen
  params; nothing recomputed live. PROPOSAL-ONLY: never replaces live
  `calibrateProbability` / `calibration_maps.json` / `calibration_meta.json`.
- `scripts/run_oof_calibration.py` — CLI writing proposal artifacts to
  `data/models/` only.
- `src/probability_calibrator.py` — P6 retarget. `retrain_all_game()` is the new
  PRIMARY path: reads all-game `model_predictions` joined to `game_outcomes`
  (promotion-eligible, unselected) using `raw_home_probability` vs home-win
  outcome. Errors explicitly when migration-006 tables are absent (never
  fabricates, never silently falls back to selected-value).
  `retrain_default()` now prefers all-game; on missing-migration it falls back to
  CSV `prediction_outcomes` (NOT the selected-value ledger). The legacy
  `retrain_from_sqlite` (`bet_ledger`) is renamed the explicitly named
  `selected_value` diagnostic with a selection-bias warning; it is never the
  default truth. `/evolve` (which calls `retrain()` / CSV directly) is untouched.
- `tests/test_p6_oof_calibration.py` (14 tests) + `tests/test_p6_calibration_proposal.js`
  (13 tests): prequential leakage guard (fold k from earlier folds only, first
  fold identity), holdout scored once never fit, beta never deployable, unstable
  method skipped, proposal writes never touch live files, hash tamper-detect,
  insufficient-data gate, JS/Python hash + application parity on Platt + isotonic.

P6 gate met: leakage tests prove no scored label entered model or calibrator
fit; Python/JS calibration parity and frozen replay pass; current production
calibration remains unchanged by default (proposal artifacts only; no activation).

## 10.6 P7 diagnostics, comparison, and evidence-bound recommendation

`src/eval/generate_p7_reports.py` (`generate_p7_reports`) produces seven reports
plus a final recommendation from real saved outputs only (model_predictions +
game_outcomes + market_quote_pairs). CLI: `scripts/run_p7_reports.py`. It never
mutates production tables (read-only SQLite open) and never fabricates missing
provenance, metrics, or promotion rows.

Reports written to `reports/`:
- `model_comparison.md` + `.json` — control vs home/Elo/market baselines on
  identical walk-forward test folds; common-intersection metrics for control vs
  same-book no-vig market on with-market rows. Holdout not opened here.
- `ablation_index.md` — index of P5 per-family ablation reports.
- `calibration_oof.md` — summarizes the P6 OOF proposal artifact if present;
  reports absence (no fabrication) otherwise.
- `accuracy_coverage.md` — accuracy at FIXED coverage levels ranked by
  `abs(p - 0.5)`, NOT tuned cutoffs.
- `model_market_disagreement.md` — `control − no_vig_market` distribution +
  accuracy when model and market picks differ. Diagnostic, not a bet claim.
- `edge_buckets.md` — edge = `model − no_vig_market` on picked side. Explicitly
  NOT a bet-selection claim; VALUE/ROI secondary.
- `information_state_cohorts.md` — main / close_time / confirmed_lineup cohort
  metrics; empty cohorts reported, not fabricated.

Every report carries dataset hash, date range, row/quarantine counts, fold +
holdout status, per-model coverage, accuracy/Brier/log loss/AUC/ECE, and
missing-data notes.

Final recommendation (`recommendation.md` + `.json`) is computed via
`src/eval/recommend.py` against real holdout metrics for both challengers
(`learned_v2_logistic`, `market_residual_v2`). Shadow challengers have no live
holdout predictions scored yet, so promotion is impossible by design until
chronological all-game holdout evidence accrues + explicit human approval.

Verdict is exactly one of: `KEEP V1`, `RUN V2 IN SHADOW`,
`PROMOTE LEARNED V2`, `PROMOTE MARKET RESIDUAL V2`, or
`INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE`. When every challenger lacks
holdout evidence, the honest overall verdict is INSUFFICIENT DATA — never a
silent KEEP V1. On the current production DB (228 prediction_runs, 0
promotion-eligible model_predictions, 0 market_quote_pairs) the CLI returns
`INSUFFICIENT DATA — NOT PROMOTION ELIGIBLE` (holdout_rows=0).

P7 gate met: all reports produced from real outputs; no fabrication; holdout
never opened in OOF/test sections; recommendation evidence-bound.

## 11. Calibration/evaluation selection bias

Historical calibration (`data/calibration_meta.json`, 1044/1306 rows) was trained
on `prediction_outcomes.csv`, which is selected-pick history, not all-game. This
biased calibration toward the VALUE-selected population. P6 RESOLVED this:
`retrain_all_game()` is now the primary training path over all-game
`model_predictions` + `game_outcomes` (unselected). The `bet_ledger` /
`prediction_outcomes.csv` selected-value paths are retained as explicitly named
`selected_value` diagnostics with a selection-bias warning, never the default
truth. Live V1 calibration files are unchanged by default until a proposal
artifact is separately activated by human approval.

## 12. Feature roles

Manifest: `src/core/feature_roles.js` (`control-feature-roles-v1.0`).

| Role | Families |
|---|---|
| `active` | team_season_basic, rolling_team_form, probable_starter_recent, lineup, bullpen_fatigue, schedule_fatigue, weather, head_to_head, matchup_memory, team_platoon_splits, injuries |
| `defaulted` | team_season_advanced, probable_starter_season, standings_and_splits, park_factor |
| `informational_only` | player_platoon, sharp_money, market_blend_weight |
| `unused` | statcast, batter_vs_pitcher, pitch_arsenal, travel_distance, umpire |

`defaulted` = collected but core substitutes defaults when missing.
`informational_only` = collected, never enters probability.
`unused` = no live collection.

## 13. P0–P7 status

| Phase | Status |
|---|---|
| P0 correctness/audit/observability | COMPLETE (calibration hardened, replay hash-locked, availability expanded, fixtures added, docs created; npm test green 2026-08-13) |
| P1 immutable history/outcomes/folds/baselines | COMPLETE (migration 006, model_predictions, market_quote_pairs, dataset builder, folds, baselines, recommend; npm test green 2026-08-13) |
| P2 learned_v2_logistic challenger | COMPLETE (trainer, JS inference, model registry/shadow orchestrator, feature-vector persistence, parity tests; npm test green 2026-08-13) |
| P3 market_residual_v2 challenger | COMPLETE (fixed-offset residual trainer, JS inference, registry shadow wiring, offset-fixity guard, no-market unavailable behavior, JS/Python parity; npm test green 2026-08-13) |
| P4 timestamp-safe candidate features | COMPLETE (candidate extractor + JS collectors + feature_quality extension + JS/Python parity; npm test green 2026-08-13) |
| P5 chronological ablations | COMPLETE (ablation engine + CLI + control/candidate family schemas + JSON/MD reports + tests; npm test green 2026-08-13) |
| P6 OOF calibration + artifact governance | COMPLETE (all-game OOF engine + CLI + JS proposal reader + retargeted primary calibrator; npm test green 2026-08-13) |
| P7 reports + evidence-bound recommendation | COMPLETE (report generator + CLI; 7 reports + recommendation from real saved outputs; honest INSUFFICIENT DATA when no promotion-eligible rows; npm test green 2026-08-13) |

No challenger is active. `MLB_MODEL_VERSION` defaults to `heuristic_v1`.
Promotion requires chronological all-game evidence + explicit human approval.
