import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { Storage } from '../src/storage.js';
import {
  assembleAuditCard,
  buildContributions,
  findAuditRow,
  formatAuditCard,
  handleAuditCardQuery,
  listAuditRows
} from '../src/auditCard.js';

function freshStorage() {
  const tempDir = resolve(process.cwd(), '.tmp-audit-card-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(
    tempDir,
    `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  return { storage: new Storage(statePath) };
}

const BREAKDOWN = {
  rawEdge: 0.31,
  dampenedEdge: 0.155,
  dampeningFactor: 0.5,
  recordDominated: false,
  offenseEdge: 0.1,
  preventionEdge: 0.05,
  starterEdge: 0.12,
  lineupEdge: 0.01,
  bullpenEdge: -0.02,
  fatigueEdge: 0,
  log5Edge: 0.02,
  formEdge: 0.01,
  h2hEdge: 0,
  memoryEdge: 0,
  platoonEdge: 0,
  homeFieldEdge: 0.02,
  weatherEdge: 0,
  confirmationEdge: 0
};

function seed(storage) {
  const db = storage.db;
  const now = '2026-08-20T12:00:30.000Z';
  const asOf = '2026-08-20T12:00:00.000Z';
  const firstPitch = '2026-08-20T23:00:00Z';

  db.prepare(
    `INSERT INTO prediction_runs (run_id, game_pk, market, date_ymd, as_of_utc, first_pitch_utc, model_version, payload, created_at)
     VALUES (?, ?, 'moneyline', ?, ?, ?, ?, ?, ?)`
  ).run(
    'run-t1', '900001', '2026-08-20', asOf, firstPitch, 'moneyline-core-v1.0',
    JSON.stringify({ snapshotPath: '/tmp/none.json' }), now
  );

  db.prepare(
    `INSERT INTO model_predictions (
       prediction_id, run_id, game_pk, date_ymd, model_id, model_impl_version,
       raw_home_probability, raw_away_probability,
       calibrated_home_probability, calibrated_away_probability,
       pick_side, pick_team_id, pick_probability, status,
       paired_quote_pair_id, as_of_utc, first_pitch_utc, information_state,
       promotion_eligible, calibration_version, snapshot_hash, payload, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'mp-run-t1-heuristic_v1', 'run-t1', '900001', '2026-08-20',
    'heuristic_v1', 'moneyline-core-v1.0',
    55, 45, 53, 47, 'home', '137', 53, 'NO BET',
    'qp-post', asOf, firstPitch, 'projected_lineup',
    1, 'cal-test', 'hash-t1',
    JSON.stringify({ modelBreakdown: BREAKDOWN, featureFallbacks: { features: ['probable_starter_season'] } }),
    now
  );

  // Quote BEFORE as_of (the only legitimate "at prediction" market context).
  db.prepare(
    `INSERT INTO market_quote_pairs (
       quote_pair_id, game_pk, bookmaker, market, home_odds, away_odds,
       home_no_vig_prob, away_no_vig_prob, fetched_at_utc, first_pitch_utc,
       is_opening, is_closing, is_eligible, created_at
     ) VALUES (?, ?, ?, 'moneyline', ?, ?, ?, ?, ?, ?, 1, 0, 1, ?)`
  ).run('qp-pre', '900001', 'fanduel', -120, 110, 0.53, 0.47, '2026-08-20T11:30:00.000Z', firstPitch, now);

  // Quote AFTER as_of, wrongly paired to the prediction — must be rejected.
  db.prepare(
    `INSERT INTO market_quote_pairs (
       quote_pair_id, game_pk, bookmaker, market, home_odds, away_odds,
       home_no_vig_prob, away_no_vig_prob, fetched_at_utc, first_pitch_utc,
       is_opening, is_closing, is_eligible, created_at
     ) VALUES (?, ?, ?, 'moneyline', ?, ?, ?, ?, ?, ?, 0, 1, 1, ?)`
  ).run('qp-post', '900001', 'draftkings', -140, 130, 0.57, 0.43, '2026-08-20T22:55:00.000Z', firstPitch, now);

  db.prepare(
    `INSERT INTO picks (
       prediction_run_id, game_pk, run_id, date_ymd, matchup,
       away_team_id, home_team_id, saved_at, payload, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'uuid-t1', '900001', 'run-t1', '2026-08-20', 'AZ Test @ SF Test',
    '109', '137', now,
    JSON.stringify({
      home: { id: 137, name: 'SF Test', abbreviation: 'SF' },
      away: { id: 109, name: 'AZ Test', abbreviation: 'AZ' },
      betDecision: {
        status: 'NO BET',
        reasons: ['edge di bawah threshold'],
        edge: 1.2,
        odds: -120,
        book: 'FanDuel',
        teamName: 'SF Test'
      },
      predictionQuality: { status: 'DEGRADED', reasons: ['missing_probable_starter_identity'] }
    }),
    now
  );

  db.prepare(
    `INSERT INTO game_outcomes (game_pk, date_ymd, home_team_id, away_team_id, home_score, away_score, winner_team_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('900001', '2026-08-20', '137', '109', 5, 3, '137', now);
}

test('buildContributions sums exactly to rawEdge and flags completeness', () => {
  const result = buildContributions(BREAKDOWN);
  assert.ok(result);
  assert.equal(result.complete, true);
  const total = result.rows.reduce((sum, row) => sum + row.contribution, 0);
  assert.ok(Math.abs(total - BREAKDOWN.rawEdge) < 1e-9);

  // record-dominated: record-context components carry the production 0.45.
  const dominated = { ...BREAKDOWN, recordDominated: true, rawEdge: 0.28 + 0.03 * 0.45 };
  const result2 = buildContributions(dominated);
  assert.equal(result2.complete, true);
  const log5 = result2.rows.find((row) => row.label === 'season record (log5)');
  assert.ok(Math.abs(log5.contribution - 0.02 * 0.45) < 1e-12);

  assert.equal(buildContributions(null), null);
  assert.equal(buildContributions({}), null);
});

test('listAuditRows dedupes to the latest prediction per game+model', () => {
  const { storage } = freshStorage();
  seed(storage);
  // Older duplicate run for the same game+model must not appear.
  storage.db.prepare(
    `INSERT INTO prediction_runs (run_id, game_pk, market, date_ymd, created_at)
     VALUES ('run-t0', '900001', 'moneyline', '2026-08-20', '2026-08-20T10:00:00.000Z')`
  ).run();
  storage.db.prepare(
    `INSERT INTO model_predictions (prediction_id, run_id, game_pk, date_ymd, model_id, status, created_at)
     VALUES ('mp-run-t0-heuristic_v1', 'run-t0', '900001', '2026-08-20', 'heuristic_v1', 'NO BET', '2026-08-20T10:00:00.000Z')`
  ).run();

  const rows = listAuditRows(storage.db, '2026-08-20');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prediction_id, 'mp-run-t1-heuristic_v1');
  assert.equal(rows[0].matchup, 'AZ Test @ SF Test');
  assert.equal(Boolean(rows[0].has_result), true);
  storage.close?.();
});

test('findAuditRow resolves by prediction id, game_pk, and team text', () => {
  const { storage } = freshStorage();
  seed(storage);
  assert.equal(findAuditRow(storage.db, 'mp-run-t1-heuristic_v1').run_id, 'run-t1');
  assert.equal(findAuditRow(storage.db, '900001').run_id, 'run-t1');
  assert.equal(findAuditRow(storage.db, 'sf test').run_id, 'run-t1');
  assert.equal(findAuditRow(storage.db, 'sf test', '2026-01-01'), null);
  assert.equal(findAuditRow(storage.db, 'tim tidak ada'), null);
  storage.close?.();
});

test('audit card rejects post-as_of paired quote and falls back to pre-as_of', () => {
  const { storage } = freshStorage();
  seed(storage);
  const mp = findAuditRow(storage.db, 'mp-run-t1-heuristic_v1');
  const card = assembleAuditCard(storage.db, mp);
  // paired_quote_pair_id points at qp-post (after as_of) — must NOT be used.
  assert.equal(card.market.atPrediction.quote_pair_id, 'qp-pre');
  assert.equal(card.market.source, 'nearest_pre_as_of');
  // The post-as_of quote is only visible as closing (evaluation-only).
  assert.equal(card.market.closing.quote_pair_id, 'qp-post');
  storage.close?.();
});

test('formatAuditCard renders all sections without fabricating missing data', () => {
  const { storage } = freshStorage();
  seed(storage);
  const mp = findAuditRow(storage.db, 'mp-run-t1-heuristic_v1');
  const text = formatAuditCard(assembleAuditCard(storage.db, mp));

  for (const expected of [
    'PREDICTION AUDIT CARD',
    'AZ Test @ SF Test',
    'heuristic_v1 moneyline-core-v1.0',
    'raw model: AZ 45.0% / SF 55.0%',
    'calibrated: AZ 47.0% / SF 53.0%',
    'market no-vig: AZ 47.0% / SF 53.0%',
    'KEPUTUSAN: NO BET',
    'edge di bawah threshold',
    'KONTRIBUSI FITUR',
    'dekomposisi exact',
    'DATA QUALITY',
    'skor: AZ 3 — SF 5',
    '✅ BENAR',
    'id: mp-run-t1-heuristic_v1',
    'promotion eligible: ya'
  ]) {
    assert.ok(text.includes(expected), `missing: ${expected}`);
  }
  // Raw and calibrated stay distinct lines — never blended.
  assert.notEqual(
    text.indexOf('raw model:'),
    text.indexOf('calibrated:')
  );
  storage.close?.();
});

test('handleAuditCardQuery: list mode, date parsing, not-found, missing table', () => {
  const { storage } = freshStorage();
  seed(storage);
  const list = handleAuditCardQuery(storage.db, '');
  assert.ok(list.includes('PREDICTION AUDIT'));
  assert.ok(list.includes('AZ Test @ SF Test'));

  const dated = handleAuditCardQuery(storage.db, '2026-08-20');
  assert.ok(dated.includes('Prediksi 2026-08-20'));

  const card = handleAuditCardQuery(storage.db, '2026-08-20 sf test');
  assert.ok(card.includes('PREDICTION AUDIT CARD'));

  const missing = handleAuditCardQuery(storage.db, 'tim tidak ada');
  assert.ok(missing.includes('Tidak ketemu'));

  storage.db.exec('DROP TABLE model_predictions');
  const noTable = handleAuditCardQuery(storage.db, '');
  assert.ok(noTable.includes('migrasi 006'));
  storage.close?.();
});

test.after(() => {
  rmSync(resolve(process.cwd(), '.tmp-audit-card-tests'), { recursive: true, force: true });
});
