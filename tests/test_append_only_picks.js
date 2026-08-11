import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { Storage } from '../src/storage.js';
import { resolveClvSide } from '../src/clv_side.js';

function team(id, name, abbreviation) {
  return { id, name, abbreviation };
}

function basePrediction(gamePk, dateYmd, away, home, overrides = {}) {
  return {
    gamePk,
    dateYmd,
    status: 'Scheduled',
    matchup: `${away.name} @ ${home.name}`,
    away: { ...away, winProbability: 45 },
    home: { ...home, winProbability: 55 },
    winner: { ...home, winProbability: 55 },
    pick: { ...home, winProbability: 55, confidence: 'model' },
    ...overrides
  };
}

function valuePrediction(gamePk, dateYmd, away, home, side, { odds, stake, model, fair, teamId }) {
  const pickTeam = side === 'away' ? away : home;
  const valueTeam =
    teamId != null
      ? [away, home].find((t) => String(t.id) === String(teamId)) || pickTeam
      : pickTeam;
  const valueSide =
    String(valueTeam.id) === String(home.id)
      ? 'home'
      : String(valueTeam.id) === String(away.id)
        ? 'away'
        : side;
  return {
    ...basePrediction(gamePk, dateYmd, away, home),
    // Model/display winner can disagree with value side.
    winner: { ...home, winProbability: 55 },
    pick: { ...home, winProbability: 55, confidence: 'model' },
    valuePick: {
      side: valueSide,
      teamId: valueTeam.id,
      teamName: valueTeam.name,
      odds,
      modelProbability: model,
      fairProbability: fair,
      edge: Math.round((model - fair) * 10) / 10,
      kellyStakePercent: stake,
      book: 'draftkings',
      quoteId: `q-${gamePk}-${valueSide}`
    },
    betDecision: {
      status: 'VALUE',
      teamName: valueTeam.name,
      odds,
      edge: model - fair,
      reasons: []
    }
  };
}

function gameResult(gamePk, away, home, awayScore, homeScore) {
  const winner = awayScore > homeScore ? away : home;
  const loser = awayScore > homeScore ? home : away;
  return {
    gamePk,
    away: { ...away, score: awayScore },
    home: { ...home, score: homeScore },
    winner,
    loser
  };
}

function freshStorage(prefix = 'append-only') {
  const tempDir = resolve(process.cwd(), `.tmp-${prefix}-tests`);
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(
    tempDir,
    `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  return { storage: new Storage(statePath), tempDir, statePath };
}

test('picks are append-only: second save keeps history and bumps version', () => {
  const { storage } = freshStorage();
  const away = team(111, 'Away', 'AWY');
  const home = team(222, 'Home', 'HOM');
  const gamePk = 900001;
  const dateYmd = '2026-08-01';

  // compactPrediction forces pick.source='baseline-model'; identity change
  // is carried by pick team id / modelBreakdown, not source string.
  const v1 = basePrediction(gamePk, dateYmd, away, home, {
    pick: { ...home, winProbability: 55, confidence: 'model' },
    winner: { ...home, winProbability: 55 },
    modelBreakdown: { tag: 'v1', pureHomeProbability: 55 }
  });
  storage.savePredictions(dateYmd, [v1]);

  const first = storage.getPrediction(gamePk);
  assert.ok(first.predictionRunId);
  assert.equal(first.predictionVersion, 1);
  assert.equal(String(first.pick?.id), String(home.id));
  assert.equal(first.modelBreakdown?.tag, 'v1');

  const v2 = basePrediction(gamePk, dateYmd, away, home, {
    pick: { ...away, winProbability: 52, confidence: 'model' },
    winner: { ...away, winProbability: 52 },
    away: { ...away, winProbability: 52 },
    home: { ...home, winProbability: 48 },
    modelBreakdown: { tag: 'v2', pureHomeProbability: 48 }
  });
  storage.savePredictions(dateYmd, [v2]);

  const latest = storage.getPrediction(gamePk);
  assert.equal(latest.predictionVersion, 2);
  assert.equal(String(latest.pick?.id), String(away.id));
  assert.equal(latest.modelBreakdown?.tag, 'v2');
  assert.notEqual(latest.predictionRunId, first.predictionRunId);

  const rows = storage.db
    .prepare(
      `SELECT prediction_run_id, prediction_version, pick_team_id, payload_hash
       FROM picks WHERE game_pk = ? ORDER BY prediction_version ASC`
    )
    .all(String(gamePk));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].prediction_version, 1);
  assert.equal(String(rows[0].pick_team_id), String(home.id));
  assert.equal(rows[1].prediction_version, 2);
  assert.equal(String(rows[1].pick_team_id), String(away.id));
  assert.notEqual(rows[0].payload_hash, rows[1].payload_hash);
  // History row payload must still be readable and not overwritten.
  const hist = storage.db
    .prepare('SELECT payload FROM picks WHERE prediction_run_id = ?')
    .get(first.predictionRunId);
  const histPayload = JSON.parse(hist.payload);
  assert.equal(String(histPayload.pick?.id), String(home.id));
  assert.equal(histPayload.modelBreakdown?.tag, 'v1');
  assert.equal(histPayload.predictionVersion, 1);

  storage.close();
});

test('markPostGameProcessed mutates pick_processing only, not picks payload', () => {
  const { storage } = freshStorage();
  const away = team(1, 'A', 'AAA');
  const home = team(2, 'B', 'BBB');
  const gamePk = 900002;
  const dateYmd = '2026-08-02';
  storage.savePredictions(dateYmd, [basePrediction(gamePk, dateYmd, away, home)]);
  const before = storage.db
    .prepare(
      `SELECT prediction_run_id, payload_hash, post_game_processed, payload
       FROM picks WHERE game_pk = ?`
    )
    .get(String(gamePk));
  assert.equal(before.post_game_processed, 0);

  storage.markPostGameProcessed(gamePk);

  const after = storage.db
    .prepare(
      `SELECT prediction_run_id, payload_hash, post_game_processed, payload
       FROM picks WHERE game_pk = ?`
    )
    .get(String(gamePk));
  assert.equal(after.prediction_run_id, before.prediction_run_id);
  assert.equal(after.payload_hash, before.payload_hash);
  assert.equal(after.payload, before.payload);
  // Legacy column on picks may stay 0; operational flag lives on pick_processing.
  assert.equal(after.post_game_processed, 0);
  const proc = storage.db
    .prepare('SELECT post_game_processed FROM pick_processing WHERE game_pk = ?')
    .get(String(gamePk));
  assert.equal(proc.post_game_processed, 1);
  assert.equal(storage.getPrediction(gamePk).postGameProcessed, true);
  storage.close();
});

test('recordBet stores prediction_run_id from latest pick', () => {
  const { storage } = freshStorage();
  const away = team(10, 'Away', 'AWY');
  const home = team(20, 'Home', 'HOM');
  const gamePk = 900003;
  const dateYmd = '2026-08-03';
  const pred = valuePrediction(gamePk, dateYmd, away, home, 'away', {
    odds: 140,
    stake: 2,
    model: 58,
    fair: 50,
    teamId: 10
  });
  storage.savePredictions(dateYmd, [pred]);
  const pick = storage.getPrediction(gamePk);
  const id = storage.recordBet(pred, dateYmd);
  assert.ok(id);
  const ledger = storage.db
    .prepare('SELECT prediction_run_id, side, selected_team_id FROM bet_ledger WHERE game_pk = ?')
    .get(String(gamePk));
  assert.equal(ledger.prediction_run_id, pick.predictionRunId);
  assert.equal(ledger.side, 'away');
  assert.equal(String(ledger.selected_team_id), '10');
  storage.close();
});

test('listPendingPredictionDates uses game_pk join and survives version bump', () => {
  const { storage } = freshStorage();
  const away = team(3, 'Away', 'AWY');
  const home = team(4, 'Home', 'HOM');
  const gamePk = 900004;
  const dateYmd = '2026-08-04';
  storage.savePredictions(dateYmd, [basePrediction(gamePk, dateYmd, away, home)]);
  assert.deepEqual(storage.listPendingPredictionDates(), [dateYmd]);

  // New version while still unprocessed must keep date pending via game_pk join.
  storage.savePredictions(dateYmd, [
    basePrediction(gamePk, dateYmd, away, home, {
      pick: { ...away, winProbability: 51, confidence: 'model', source: 'v2' }
    })
  ]);
  assert.deepEqual(storage.listPendingPredictionDates(), [dateYmd]);

  storage.markPostGameProcessed(gamePk);
  assert.deepEqual(storage.listPendingPredictionDates(), []);
  storage.close();
});

test('listPendingPredictionDates includes open shadow and stranded open real rows', () => {
  const { storage } = freshStorage();
  const away = team(30, 'Away', 'AWY');
  const home = team(40, 'Home', 'HOM');
  const dateYmd = '2026-08-11';

  // Insert a pick that is already processed but has an open shadow row.
  // This simulates the stranded-shadow recovery scenario.
  const pred = valuePrediction(900010, dateYmd, away, home, 'away', {
    odds: 150, stake: 2, model: 58, fair: 50, teamId: 30
  });
  storage.savePredictions(dateYmd, [pred]);
  const pick = storage.getPrediction(900010);
  storage.markPostGameProcessed(900010);
  assert.deepEqual(storage.listPendingPredictionDates(), []);

  // Manually insert an open shadow row for the processed game using the
  // real prediction_run_id so the FK constraint is satisfied.
  storage.db.prepare(`INSERT INTO shadow_ledger (
    shadow_decision_id, game_pk, prediction_run_id, date_ymd, market,
    team, side, selected_team_id, odds, fair_prob, model_prob, edge,
    simulated_units_staked, status, blocked_by, decision_hash, recommended_at
  ) VALUES (?, ?, ?, ?, 'moneyline', ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'rolling_clv_gate', ?, ?)`)
    .run(
      'shadow-2026-08-11-moneyline-900010', '900010', pick.predictionRunId,
      dateYmd, 'Away', 'away', '30', 150, 50, 58, 8, 2,
      'fake-hash', new Date().toISOString()
    );

  assert.deepEqual(storage.listPendingPredictionDates(), [dateYmd]);

  // Clean up then verify stranded real open row also surfaces.
  storage.db.prepare('DELETE FROM shadow_ledger').run();
  storage.db.prepare(`INSERT INTO bet_ledger (
    decision_id, game_pk, prediction_run_id, date_ymd, market, team, side, odds,
    fair_prob, model_prob, edge, units_staked, status, recommended_at,
    decision_hash, selected_team_id
  ) VALUES (?, ?, ?, ?, 'moneyline', ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
    .run(
      '2026-08-11-moneyline-900010', '900010', pick.predictionRunId, dateYmd,
      'Away', 'away', 150, 50, 58, 8, 2, new Date().toISOString(), 'fake-hash', '30'
    );

  assert.deepEqual(storage.listPendingPredictionDates(), [dateYmd]);

  storage.close();
});

test('processPostGameOutcome atomic: settle failure leaves open + unprocessed', () => {
  const { storage } = freshStorage();
  const away = team(5, 'Away', 'AWY');
  const home = team(6, 'Home', 'HOM');
  const gamePk = 900005;
  const dateYmd = '2026-08-05';
  const pred = valuePrediction(gamePk, dateYmd, away, home, 'home', {
    odds: -110,
    stake: 2,
    model: 57,
    fair: 50
  });
  storage.savePredictions(dateYmd, [pred]);
  storage.recordBet(pred, dateYmd);

  const originalSettle = storage.settleBet.bind(storage);
  storage.settleBet = () => false;

  const out = storage.processPostGameOutcome(pred, gameResult(gamePk, away, home, 1, 4), {
    enabled: true,
    clv: 0.3
  });
  assert.equal(out.processed, false);
  assert.equal(out.settled, false);
  assert.equal(out.error, 'settle_failed');
  assert.equal(storage.getPrediction(gamePk).postGameProcessed, false);
  assert.ok(storage.getOpenBet(gamePk));

  storage.settleBet = originalSettle;
  const retry = storage.processPostGameOutcome(pred, gameResult(gamePk, away, home, 1, 4), {
    enabled: true,
    clv: 0.3
  });
  assert.equal(retry.processed, true);
  assert.equal(retry.settled, true);
  assert.equal(storage.getOpenBet(gamePk), null);
  storage.close();
});

test('CLV and P/L share ledger side; VALUE refuses display-pick fallback', () => {
  const { storage } = freshStorage();
  const away = team(146, 'Miami Marlins', 'MIA');
  const home = team(115, 'Colorado Rockies', 'COL');
  const gamePk = 900006;
  const dateYmd = '2026-08-06';
  // Display pick home, value bet away
  const pred = valuePrediction(gamePk, dateYmd, away, home, 'away', {
    odds: 150,
    stake: 3.5,
    model: 58,
    fair: 50,
    teamId: 146
  });
  pred.pick = { ...home, winProbability: 55, confidence: 'model' };
  pred.winner = { ...home, winProbability: 55 };

  storage.savePredictions(dateYmd, [pred]);
  storage.recordBet(pred, dateYmd);

  const sideFromLedger = resolveClvSide(pred, storage, { requireValueSide: true });
  assert.equal(sideFromLedger, 'away');
  assert.equal(storage.getLedgerSide(gamePk), 'away');

  // Away wins → settle win on value side (not display home)
  storage.settleBet(pred, gameResult(gamePk, away, home, 6, 2), 1.1);
  const row = storage.readLedger()[0];
  assert.equal(row.side, 'away');
  assert.equal(row.result, 'win');
  assert.equal(row.clv, 1.1);

  // Without ledger/storage, VALUE still uses valuePick not display pick
  const sideFromValue = resolveClvSide(
    { ...pred, gamePk: 999999 },
    null,
    { requireValueSide: true }
  );
  assert.equal(sideFromValue, 'away');

  // VALUE with no valuePick/ledger must not invent display side
  const noValue = basePrediction(gamePk, dateYmd, away, home, {
    betDecision: { status: 'VALUE', reasons: [] }
  });
  assert.equal(resolveClvSide(noValue, null, { requireValueSide: true }), null);

  // Non-VALUE may fall back to display pick
  assert.equal(resolveClvSide(noValue, null, { requireValueSide: false }), 'home');
  storage.close();
});

test.after(() => {
  rmSync(resolve(process.cwd(), '.tmp-append-only-tests'), {
    recursive: true,
    force: true
  });
});
