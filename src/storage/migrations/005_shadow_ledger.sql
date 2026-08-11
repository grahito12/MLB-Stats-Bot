-- Paper-only ledger for VALUE candidates blocked by the rolling CLV gate.
-- Rows are isolated from real bet_ledger/settlements and use first-write
-- semantics on (game_pk, market) so later prediction refreshes cannot cherry-pick
-- a different side, price, probability, or simulated stake.

CREATE TABLE shadow_ledger (
  shadow_decision_id TEXT PRIMARY KEY,
  game_pk TEXT NOT NULL,
  prediction_run_id TEXT NOT NULL,
  date_ymd TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'moneyline',
  team TEXT,
  side TEXT NOT NULL,
  selected_team_id TEXT NOT NULL,
  model_pick_team_id TEXT,
  odds REAL NOT NULL,
  closing_odds REAL,
  fair_prob REAL NOT NULL,
  model_prob REAL NOT NULL,
  edge REAL NOT NULL,
  simulated_units_staked REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  result TEXT,
  simulated_units_pl REAL,
  clv REAL,
  blocked_by TEXT NOT NULL DEFAULT 'rolling_clv_gate',
  block_reason TEXT,
  gate_avg_clv REAL,
  gate_sample INTEGER,
  bookmaker TEXT,
  quote_id TEXT,
  decision_hash TEXT NOT NULL,
  model_version TEXT,
  calibration_version TEXT,
  bet_policy_version TEXT,
  run_id TEXT,
  recommended_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE(game_pk, market),
  FOREIGN KEY (prediction_run_id)
    REFERENCES picks(prediction_run_id)
    ON DELETE RESTRICT,
  CHECK (side IN ('home', 'away')),
  CHECK (status IN ('open', 'settled')),
  CHECK (simulated_units_staked > 0)
);

CREATE INDEX idx_shadow_ledger_date ON shadow_ledger(date_ymd);
CREATE INDEX idx_shadow_ledger_status ON shadow_ledger(status);
CREATE INDEX idx_shadow_ledger_run ON shadow_ledger(prediction_run_id);
