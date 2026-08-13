-- P1: immutable all-game model prediction history, market quote pairs, dataset
-- folds, and all-game run metadata. Additive only — never edits applied
-- migrations 001-005. Existing prediction_runs/prediction_decisions/bet_ledger/
-- shadow_ledger/picks remain compatible and untouched.
--
-- Contract enforced by schema + writer:
--  * model_predictions is append-only, one row per (prediction_run_id, model_id).
--  * All-game: heuristic_v1 writes a row for EVERY eligible scheduled game,
--    including NO BET games. Outcomes remain separate labels (game_outcomes).
--  * Promotion-safe rows require as_of_utc < first_pitch_utc and every used
--    input available by as_of_utc. Post-pitch rows are marked ineligible.
--  * A market quote pair is only joined to a run whose as_of_utc >= the pair's
--    fetched_at_utc. Closing proxy is the latest append-only eligible pair
--    before first pitch; never a mutable post-start overwrite.

-- Extend prediction_runs with P1 identity/provenance/quality columns. The
-- legacy columns from 002 are preserved; these are nullable additions so old
-- rows remain readable.
ALTER TABLE prediction_runs ADD COLUMN model_id TEXT;
ALTER TABLE prediction_runs ADD COLUMN model_impl_version TEXT;
ALTER TABLE prediction_runs ADD COLUMN feature_schema_version TEXT;
ALTER TABLE prediction_runs ADD COLUMN feature_hash TEXT;
ALTER TABLE prediction_runs ADD COLUMN information_state TEXT;
ALTER TABLE prediction_runs ADD COLUMN prediction_quality_status TEXT;
ALTER TABLE prediction_runs ADD COLUMN prediction_quality_reasons TEXT;
ALTER TABLE prediction_runs ADD COLUMN paired_quote_pair_id TEXT;
ALTER TABLE prediction_runs ADD COLUMN producer_timestamp_utc TEXT;
ALTER TABLE prediction_runs ADD COLUMN core_inputs_hash TEXT;
ALTER TABLE prediction_runs ADD COLUMN normalized_feature_vector TEXT;
ALTER TABLE prediction_runs ADD COLUMN feature_manifest_version TEXT;

CREATE INDEX IF NOT EXISTS idx_prediction_runs_model ON prediction_runs(model_id);
CREATE INDEX IF NOT EXISTS idx_prediction_runs_date_model ON prediction_runs(date_ymd, model_id);
CREATE INDEX IF NOT EXISTS idx_prediction_runs_quality ON prediction_runs(prediction_quality_status);

-- Append-only per-model prediction history. One row per (run, model). The
-- control heuristic_v1 and shadow challengers each write their own row against
-- the same frozen run. This is the all-game research truth table.
CREATE TABLE IF NOT EXISTS model_predictions (
  prediction_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  game_pk TEXT NOT NULL,
  date_ymd TEXT,
  model_id TEXT NOT NULL,
  model_impl_version TEXT,
  feature_schema_version TEXT,
  model_artifact_hash TEXT,
  calibration_artifact_hash TEXT,
  calibration_status TEXT,
  -- Named probability stages (never overwritten by display blend):
  raw_home_probability REAL,
  raw_away_probability REAL,
  calibrated_home_probability REAL,
  calibrated_away_probability REAL,
  final_home_probability REAL,
  final_away_probability REAL,
  residual_logit REAL,
  display_home_probability REAL,
  display_away_probability REAL,
  -- Side selection + grading (separate from VALUE bet decision):
  pick_side TEXT,
  pick_team_id TEXT,
  pick_probability REAL,
  status TEXT,
  reason_codes TEXT,
  -- Market context paired to this run (nullable — may have no market):
  paired_quote_pair_id TEXT,
  market_no_vig_home_prob REAL,
  market_no_vig_away_prob REAL,
  -- Temporal/quality gate:
  as_of_utc TEXT,
  first_pitch_utc TEXT,
  information_state TEXT,
  promotion_eligible INTEGER NOT NULL DEFAULT 0,
  promotion_reasons TEXT,
  -- Versioning + integrity:
  model_version TEXT,
  feature_version TEXT,
  calibration_version TEXT,
  snapshot_hash TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, model_id),
  CHECK (pick_side IS NULL OR pick_side IN ('home', 'away')),
  CHECK (promotion_eligible IN (0, 1)),
  FOREIGN KEY (run_id) REFERENCES prediction_runs(run_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_model_predictions_game ON model_predictions(game_pk);
CREATE INDEX IF NOT EXISTS idx_model_predictions_model ON model_predictions(model_id);
CREATE INDEX IF NOT EXISTS idx_model_predictions_date ON model_predictions(date_ymd);
CREATE INDEX IF NOT EXISTS idx_model_predictions_run ON model_predictions(run_id);
CREATE INDEX IF NOT EXISTS idx_model_predictions_promo ON model_predictions(model_id, promotion_eligible);

-- Complete same-book home/away quote pairs from raw Odds API bookmaker markets.
-- Deterministic quote_pair_id ties a model run to the exact market it saw.
-- Separately recorded from best-price line shopping (which serves betting).
CREATE TABLE IF NOT EXISTS market_quote_pairs (
  quote_pair_id TEXT PRIMARY KEY,
  game_pk TEXT NOT NULL,
  source_event_id TEXT,
  bookmaker TEXT,
  market TEXT NOT NULL DEFAULT 'moneyline',
  home_odds REAL,
  away_odds REAL,
  home_implied_prob REAL,
  away_implied_prob REAL,
  overround REAL,
  home_no_vig_prob REAL,
  away_no_vig_prob REAL,
  bookmaker_last_update TEXT,
  fetched_at_utc TEXT,
  observed_at_utc TEXT,
  first_pitch_utc TEXT,
  as_of_utc TEXT,
  is_opening INTEGER NOT NULL DEFAULT 0,
  is_closing INTEGER NOT NULL DEFAULT 0,
  is_eligible INTEGER NOT NULL DEFAULT 1,
  ineligibility_reason TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(game_pk, bookmaker, market, home_odds, away_odds, fetched_at_utc)
);

CREATE INDEX IF NOT EXISTS idx_quote_pairs_game ON market_quote_pairs(game_pk, market);
CREATE INDEX IF NOT EXISTS idx_quote_pairs_as_of ON market_quote_pairs(game_pk, market, as_of_utc);
CREATE INDEX IF NOT EXISTS idx_quote_pairs_first_pitch ON market_quote_pairs(game_pk, first_pitch_utc);
CREATE INDEX IF NOT EXISTS idx_quote_pairs_eligible ON market_quote_pairs(is_eligible, is_closing);

-- Chronological fold manifest for walk-forward evaluation. Same-date games
-- stay together; last contiguous block is untouched holdout. Persisted so
-- every model is scored on identical partitions.
CREATE TABLE IF NOT EXISTS model_dataset_folds (
  fold_id TEXT PRIMARY KEY,
  fold_index INTEGER NOT NULL,
  fold_type TEXT NOT NULL,           -- 'train', 'test', 'holdout'
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,            -- half-open: test/holdout end is exclusive boundary
  train_start_date TEXT,
  train_end_date TEXT,
  game_count INTEGER,
  date_count INTEGER,
  dataset_hash TEXT,
  manifest_version TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(fold_index, fold_type)
);

CREATE INDEX IF NOT EXISTS idx_folds_type ON model_dataset_folds(fold_type);
CREATE INDEX IF NOT EXISTS idx_folds_dates ON model_dataset_folds(start_date, end_date);
