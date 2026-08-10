-- Make prediction picks immutable and keyed by prediction-run identity.
-- game_pk remains a non-unique lookup key. Post-game processing state lives in
-- pick_processing so no prediction row is mutated after insertion.

-- Child tables previously referenced picks(game_pk), which is no longer unique.
-- Move them aside while replacing the parent and rebuild them against
-- picks(prediction_run_id).
ALTER TABLE yrfi_results RENAME TO yrfi_results_legacy;
ALTER TABLE bet_ledger RENAME TO bet_ledger_legacy;
ALTER TABLE picks RENAME TO picks_legacy;

DROP INDEX IF EXISTS idx_picks_date;
DROP INDEX IF EXISTS idx_picks_post_game;
DROP INDEX IF EXISTS idx_yrfi_date;
DROP INDEX IF EXISTS idx_bet_ledger_date;
DROP INDEX IF EXISTS idx_bet_ledger_status;

CREATE TABLE picks (
  prediction_run_id TEXT PRIMARY KEY,
  game_pk TEXT NOT NULL,
  prediction_version INTEGER NOT NULL DEFAULT 1,
  run_id TEXT,
  model_version TEXT,
  feature_version TEXT,
  calibration_version TEXT,
  bet_policy_version TEXT,
  snapshot_hash TEXT,
  payload_hash TEXT,
  date_ymd TEXT NOT NULL,
  status TEXT,
  matchup TEXT,
  away_team_id TEXT,
  home_team_id TEXT,
  pick_team_id TEXT,
  pick_confidence TEXT,
  pick_source TEXT,
  post_game_processed INTEGER NOT NULL DEFAULT 0,
  post_game_processed_at TEXT,
  saved_at TEXT,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  feature_fallback_count INTEGER,
  fallback_features_used TEXT
);

CREATE INDEX idx_picks_game_pk ON picks(game_pk);
CREATE INDEX idx_picks_date ON picks(date_ymd);
CREATE INDEX idx_picks_version ON picks(game_pk, prediction_version DESC);

-- Operational state is separate from immutable prediction rows.
CREATE TABLE pick_processing (
  game_pk TEXT PRIMARY KEY,
  prediction_run_id TEXT NOT NULL,
  post_game_processed INTEGER NOT NULL DEFAULT 0,
  post_game_processed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (prediction_run_id) REFERENCES picks(prediction_run_id) ON DELETE RESTRICT
);
CREATE INDEX idx_pick_processing_run ON pick_processing(prediction_run_id);

-- Preserve one legacy row per game, assigning a UUID-shaped run identity.
INSERT INTO picks (
  prediction_run_id, game_pk, prediction_version, run_id,
  model_version, feature_version, calibration_version, bet_policy_version,
  snapshot_hash, payload_hash, date_ymd, status, matchup,
  away_team_id, home_team_id, pick_team_id, pick_confidence, pick_source,
  post_game_processed, post_game_processed_at, saved_at, payload, updated_at,
  feature_fallback_count, fallback_features_used
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(6))),
  game_pk, 1,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  date_ymd, status, matchup, away_team_id, home_team_id, pick_team_id,
  pick_confidence, pick_source, post_game_processed, post_game_processed_at,
  saved_at, payload, updated_at, feature_fallback_count, fallback_features_used
FROM picks_legacy;

INSERT INTO pick_processing (
  game_pk, prediction_run_id, post_game_processed, post_game_processed_at, updated_at
)
SELECT p.game_pk, p.prediction_run_id, p.post_game_processed,
       p.post_game_processed_at, COALESCE(p.updated_at, CURRENT_TIMESTAMP)
FROM picks p;

CREATE TABLE yrfi_results (
  game_pk TEXT PRIMARY KEY,
  prediction_run_id TEXT,
  date_ymd TEXT NOT NULL,
  pick TEXT,
  probability INTEGER,
  source TEXT,
  prediction_payload TEXT,
  actual_any_run INTEGER,
  actual_pick TEXT,
  correct INTEGER,
  processed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (prediction_run_id) REFERENCES picks(prediction_run_id) ON DELETE RESTRICT
);
CREATE INDEX idx_yrfi_date ON yrfi_results(date_ymd);

INSERT INTO yrfi_results (
  game_pk, prediction_run_id, date_ymd, pick, probability, source,
  prediction_payload, actual_any_run, actual_pick, correct, processed_at, updated_at
)
SELECT y.game_pk, p.prediction_run_id, y.date_ymd, y.pick, y.probability, y.source,
       y.prediction_payload, y.actual_any_run, y.actual_pick, y.correct,
       y.processed_at, y.updated_at
FROM yrfi_results_legacy y
LEFT JOIN picks p ON p.game_pk = y.game_pk;

CREATE TABLE bet_ledger (
  decision_id TEXT PRIMARY KEY,
  game_pk TEXT NOT NULL,
  prediction_run_id TEXT,
  date_ymd TEXT NOT NULL,
  market TEXT NOT NULL,
  team TEXT,
  side TEXT,
  line REAL,
  odds REAL,
  fair_prob REAL,
  model_prob REAL,
  edge REAL,
  units_staked REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  result TEXT,
  units_pl REAL,
  clv REAL,
  recommended_at TEXT NOT NULL,
  settled_at TEXT,
  feature_fallback_count INTEGER,
  fallback_features_used TEXT,
  selected_team_id TEXT,
  model_pick_team_id TEXT,
  bookmaker TEXT,
  quote_id TEXT,
  decision_hash TEXT,
  model_version TEXT,
  calibration_version TEXT,
  bet_policy_version TEXT,
  run_id TEXT,
  settlement_pending INTEGER NOT NULL DEFAULT 0,
  UNIQUE(game_pk, market),
  FOREIGN KEY (prediction_run_id) REFERENCES picks(prediction_run_id) ON DELETE RESTRICT
);
CREATE INDEX idx_bet_ledger_date ON bet_ledger(date_ymd);
CREATE INDEX idx_bet_ledger_status ON bet_ledger(status);

INSERT INTO bet_ledger (
  decision_id, game_pk, prediction_run_id, date_ymd, market, team, side, line, odds,
  fair_prob, model_prob, edge, units_staked, status, result, units_pl, clv,
  recommended_at, settled_at, feature_fallback_count, fallback_features_used,
  selected_team_id, model_pick_team_id, bookmaker, quote_id, decision_hash,
  model_version, calibration_version, bet_policy_version, run_id, settlement_pending
)
SELECT b.decision_id, b.game_pk, p.prediction_run_id, b.date_ymd, b.market, b.team,
       b.side, b.line, b.odds, b.fair_prob, b.model_prob, b.edge, b.units_staked,
       b.status, b.result, b.units_pl, b.clv, b.recommended_at, b.settled_at,
       b.feature_fallback_count, b.fallback_features_used, b.selected_team_id,
       b.model_pick_team_id, b.bookmaker, b.quote_id, b.decision_hash,
       b.model_version, b.calibration_version, b.bet_policy_version, b.run_id,
       b.settlement_pending
FROM bet_ledger_legacy b
LEFT JOIN picks p ON p.game_pk = b.game_pk;

DROP TABLE yrfi_results_legacy;
DROP TABLE bet_ledger_legacy;
DROP TABLE picks_legacy;
