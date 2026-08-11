import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { Storage } from '../src/storage.js';
import { formatShadowLedgerReport } from '../src/shadowLedgerReport.js';

function team(id, name, abbreviation) {
  return { id, name, abbreviation };
}

function blockedPrediction(
  gamePk,
  dateYmd,
  away,
  home,
  side = 'away',
  { odds = 150, stake = 2, model = 58, fair = 50, displaySide = 'home' } = {}
) {
  const valueTeam = side === 'away' ? away : home;
  const displayTeam = displaySide === 'away' ? away : home;
  return {
    gamePk,
    dateYmd,
    status: 'Scheduled',
    matchup: `${away.name} @ ${home.name}`,
    away: { ...away, winProbability: displaySide === 'away' ? 55 : 45 },
    home: { ...home, winProbability: displaySide === 'home' ? 55 : 45 },
    winner: { ...displayTeam, winProbability: 55 },
    pick: { ...displayTeam, winProbability: 55, confidence: 'model' },
    valuePick: {
      side,
      teamId: valueTeam.id,
      teamName: valueTeam.name,
      odds,
      modelProbability: model,
      fairProbability: fair,
      edge: model - fair,
      kellyStakePercent: stake,
      book: 'draftkings',
      quoteId: `shadow-q-${gamePk}`
    },
    betDecision: {
      status: 'NO BET',
      teamName: valueTeam.name,
      odds,
      edge: model - fair,
      reason: 'rolling avg CLV -0.60 < 0.00 (n=48)',
      reasons: ['rolling avg CLV -0.60 < 0.00 (n=48)'],
      clvGate: {
        blocked: true,
        avgClv: -0.6,
        sample: 48,
        reason: 'rolling avg CLV -0.60 < 0.00 (n=48)'
      }
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

function freshStorage() {
  const tempDir = resolve(process.cwd(), '.tmp-shadow-ledger-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(
    tempDir,
    `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  return new Storage(statePath);
}

const away = team(10, 'Away', 'AWY');
const home = team(20, 'Home', 'HOM');

test('savePredictions records only CLV-blocked qualifying VALUE in shadow ledger', () => {
  const storage = freshStorage();
  const blocked = blockedPrediction(101, '2026-08-11', away, home);
  storage.savePredictions('2026-08-11', [blocked]);

  const rows = storage.readShadowLedger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].side, 'away');
  assert.equal(String(rows[0].selected_team_id), '10');
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].blocked_by, 'rolling_clv_gate');
  assert.equal(rows[0].prediction_run_id, storage.getPrediction(101).predictionRunId);
  assert.equal(storage.readLedger({ includeArchived: true }).length, 0);

  const ordinaryNoBet = blockedPrediction(102, '2026-08-11', away, home);
  ordinaryNoBet.betDecision = { status: 'NO BET', reasons: ['edge below floor'] };
  storage.savePredictions('2026-08-11', [ordinaryNoBet]);

  const unblockedValue = blockedPrediction(103, '2026-08-11', away, home);
  unblockedValue.betDecision = { status: 'VALUE', reasons: [] };
  storage.savePredictions('2026-08-11', [unblockedValue]);

  const missingStake = blockedPrediction(104, '2026-08-11', away, home, 'away', {
    stake: 0
  });
  storage.savePredictions('2026-08-11', [missingStake]);

  assert.equal(storage.readShadowLedger().length, 1);
  assert.equal(storage.readLedger({ includeArchived: true }).length, 0);
  storage.close();
});

test('first shadow decision wins and later prediction refresh cannot overwrite it', () => {
  const storage = freshStorage();
  const first = blockedPrediction(201, '2026-08-11', away, home, 'away', {
    odds: 145,
    stake: 2.1,
    model: 58,
    fair: 50
  });
  storage.savePredictions('2026-08-11', [first]);
  const firstRow = storage.readShadowLedger()[0];

  const refresh = blockedPrediction(201, '2026-08-11', away, home, 'home', {
    odds: -115,
    stake: 4,
    model: 62,
    fair: 50,
    displaySide: 'away'
  });
  storage.savePredictions('2026-08-11', [refresh]);

  const row = storage.readShadowLedger()[0];
  assert.equal(storage.readShadowLedger().length, 1);
  assert.equal(row.shadow_decision_id, firstRow.shadow_decision_id);
  assert.equal(row.prediction_run_id, firstRow.prediction_run_id);
  assert.equal(row.side, 'away');
  assert.equal(row.odds, 145);
  assert.equal(row.simulated_units_staked, 2.1);
  assert.equal(storage.getPrediction(201).predictionVersion, 2);
  storage.close();
});

test('shadow settlement uses frozen side and American odds math, then stays idempotent', () => {
  const storage = freshStorage();
  const prediction = blockedPrediction(301, '2026-08-11', away, home, 'away', {
    odds: 150,
    stake: 3,
    displaySide: 'home'
  });
  storage.savePredictions('2026-08-11', [prediction]);

  assert.equal(storage.getShadowLedgerSide(301), 'away');
  assert.equal(
    storage.settleShadowBet(prediction, gameResult(301, away, home, 6, 2), {
      clv: 1.2,
      closingOdds: 130
    }),
    true
  );
  let row = storage.readShadowLedger()[0];
  assert.equal(row.result, 'win');
  assert.equal(row.simulated_units_pl, 4.5);
  assert.equal(row.clv, 1.2);
  assert.equal(row.closing_odds, 130);

  assert.equal(
    storage.settleShadowBet(prediction, gameResult(301, away, home, 1, 5), {
      clv: -9,
      closingOdds: 999
    }),
    false
  );
  row = storage.readShadowLedger()[0];
  assert.equal(row.result, 'win');
  assert.equal(row.simulated_units_pl, 4.5);
  assert.equal(row.clv, 1.2);
  storage.close();
});

test('shadow loss and push use simulated stake only', () => {
  const storage = freshStorage();
  const loss = blockedPrediction(401, '2026-08-11', away, home, 'home', {
    odds: -120,
    stake: 2.5,
    displaySide: 'away'
  });
  storage.savePredictions('2026-08-11', [loss]);
  storage.settleShadowBet(loss, gameResult(401, away, home, 5, 2));
  assert.equal(storage.readShadowLedger().find((row) => row.game_pk === '401').simulated_units_pl, -2.5);

  const push = blockedPrediction(402, '2026-08-11', away, home, 'home', {
    odds: -110,
    stake: 1.75
  });
  storage.savePredictions('2026-08-11', [push]);
  storage.settleShadowBet(push, { gamePk: 402, away, home, winner: null });
  const pushRow = storage.readShadowLedger().find((row) => row.game_pk === '402');
  assert.equal(pushRow.result, 'push');
  assert.equal(pushRow.simulated_units_pl, 0);
  assert.equal(storage.readLedger({ includeArchived: true }).length, 0);
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS count FROM settlements').get().count, 0);
  storage.close();
});

test('atomic post-game rollback and retry cover expected shadow settlement', () => {
  const storage = freshStorage();
  const prediction = blockedPrediction(501, '2026-08-11', away, home);
  storage.savePredictions('2026-08-11', [prediction]);
  const originalSettle = storage.settleShadowBet.bind(storage);
  storage.settleShadowBet = () => false;

  const failed = storage.processPostGameOutcome(
    prediction,
    gameResult(501, away, home, 4, 1),
    { enabled: true, shadowClv: 0.4, shadowClosingOdds: 135 }
  );
  assert.equal(failed.processed, false);
  assert.equal(failed.shadowSettled, false);
  assert.equal(failed.error, 'shadow_settle_failed');
  assert.equal(storage.getPrediction(501).postGameProcessed, false);
  assert.ok(storage.getOpenShadowBet(501));
  assert.equal(storage.getMemory().totalPicks, 0);

  storage.settleShadowBet = originalSettle;
  const retry = storage.processPostGameOutcome(
    prediction,
    gameResult(501, away, home, 4, 1),
    { enabled: true, shadowClv: 0.4, shadowClosingOdds: 135 }
  );
  assert.equal(retry.processed, true);
  assert.equal(retry.shadowSettled, true);
  assert.equal(storage.getOpenShadowBet(501), null);
  // Shadow-only settlement must not increment memory (no real bet).
  assert.equal(storage.getMemory().totalPicks, 0);
  storage.close();
});

test('processed prediction can recover stranded open shadow row without memory duplicate', () => {
  const storage = freshStorage();
  const prediction = blockedPrediction(601, '2026-08-11', away, home);
  storage.savePredictions('2026-08-11', [prediction]);
  storage.recordOutcome(prediction, gameResult(601, away, home, 4, 1), { enabled: true });
  const total = storage.getMemory().totalPicks;
  assert.ok(storage.getOpenShadowBet(601));

  const retry = storage.processPostGameOutcome(
    prediction,
    gameResult(601, away, home, 4, 1),
    { shadowClv: 0.2, shadowClosingOdds: 140 }
  );
  assert.equal(retry.shadowSettled, true);
  assert.equal(retry.retriedStranded, true);
  assert.equal(storage.getMemory().totalPicks, total);
  storage.close();
});

test('shadow report labels paper metrics, CLV, Brier, and sample progress', () => {
  const rows = [
    {
      status: 'open', market: 'moneyline', team: 'Away', odds: 150, edge: 8,
      simulated_units_staked: 2
    },
    {
      status: 'settled', market: 'moneyline', result: 'win', model_prob: 60,
      fair_prob: 50, simulated_units_staked: 2, simulated_units_pl: 3, clv: 1
    },
    {
      status: 'settled', market: 'moneyline', result: 'loss', model_prob: 60,
      fair_prob: 50, simulated_units_staked: 2, simulated_units_pl: -2, clv: -0.5
    }
  ];
  const out = formatShadowLedgerReport(rows);
  assert.match(out, /Paper \/ Shadow Ledger/);
  assert.match(out, /bukan uang nyata/);
  assert.match(out, /Record \| 1-1/);
  assert.match(out, /Simulated P\/L \| \+1\.00u/);
  assert.match(out, /Simulated ROI \| \+25\.0%/);
  assert.match(out, /Avg CLV \| \+0\.25 \(n=2/);
  assert.match(out, /Model Brier \| 0\.2600/);
  assert.match(out, /Market\/fair Brier \| 0\.2500/);
  assert.match(out, /Progress minimum \| 2\/50/);
  assert.match(out, /tidak membuka CLV gate otomatis/);
});

test('shadow settlement does not count as learned for evolution triggers', () => {
  const storage = freshStorage();
  const prediction = blockedPrediction(701, '2026-08-11', away, home);
  storage.savePredictions('2026-08-11', [prediction]);

  // Shadow-only settlement: NO real bet, NO real outcome/memory.
  const out = storage.processPostGameOutcome(
    prediction,
    gameResult(701, away, home, 4, 1),
    { shadowClv: 0.3, shadowClosingOdds: 135 }
  );
  assert.equal(out.shadowSettled, true);
  assert.equal(out.settled, false);
  assert.equal(out.processed, true);

  // Memory must NOT have been incremented — paper-only settlement is
  // invisible to the model learning log.
  const mem = storage.getMemory();
  assert.equal(mem.totalPicks, 0);
  assert.equal(mem.learningLog.length, 0);

  storage.close();
});

test('shadow with real bet both settle, but only real settlement counts as learned', () => {
  const { storage } = (() => {
    // Use a fresh function scope so we can import the same freshStorage
    // pattern but also insert a real bet.
    // We'll reuse the existing freshStorage and then recordBet + create shadow manually.
    const tempDir = resolve(process.cwd(), '.tmp-shadow-ledger-tests');
    mkdirSync(tempDir, { recursive: true });
    const statePath = resolve(
      tempDir,
      `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    const s = new Storage(statePath);
    return { storage: s };
  })();

  const pred = {
    ...blockedPrediction(702, '2026-08-11', away, home, 'away', {
      odds: 140, stake: 2, model: 58, fair: 50
    }),
    // This prediction has both betDecision (CLV-blocked) and valuePick for shadow.
    // We'll also record a real bet so both settle.
  };
  storage.savePredictions('2026-08-11', [pred]);

  // Manually insert a real open bet for the same game.
  storage.db.prepare(`INSERT INTO bet_ledger (
    decision_id, game_pk, prediction_run_id, date_ymd, market, team, side, odds,
    fair_prob, model_prob, edge, units_staked, status, recommended_at,
    decision_hash, selected_team_id
  ) VALUES (?, ?, ?, ?, 'moneyline', ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
    .run(
      '2026-08-11-moneyline-702', '702', pred.predictionRunId,
      '2026-08-11', 'Away', 'away', 140, 50, 58, 8, 2,
      new Date().toISOString(), 'fake-hash', '10'
    );

  const out = storage.processPostGameOutcome(
    pred,
    gameResult(702, away, home, 5, 2),
    { enabled: true, clv: 0.5, shadowClv: 0.5, shadowClosingOdds: 130 }
  );

  // Both should settle.
  assert.equal(out.settled, true);
  assert.equal(out.shadowSettled, true);
  assert.equal(out.processed, true);

  // Memory should increment exactly once (real settlement only).
  const mem = storage.getMemory();
  assert.equal(mem.totalPicks, 1);
  assert.equal(mem.learningLog.length, 1);

  storage.close();
});

test('settleShadowBet stores null CLV and closing_odds as SQL NULL, never zero', () => {
  const storage = freshStorage();
  const prediction = blockedPrediction(801, '2026-08-11', away, home, 'away', {
    odds: 150, stake: 3, model: 58, fair: 50
  });
  storage.savePredictions('2026-08-11', [prediction]);

  // Settle with missing CLV and closing odds — must be null, not zero.
  storage.settleShadowBet(prediction, gameResult(801, away, home, 6, 2));
  const row = storage.readShadowLedger()[0];
  assert.equal(row.result, 'win');
  assert.equal(row.clv, null);
  assert.equal(row.closing_odds, null);

  storage.close();
});

test('settleShadowBet stores null CLV/closing_odds even when undefined is passed', () => {
  const storage = freshStorage();
  const prediction = blockedPrediction(802, '2026-08-11', away, home, 'away', {
    odds: -110, stake: 2, model: 56, fair: 50
  });
  storage.savePredictions('2026-08-11', [prediction]);

  storage.settleShadowBet(prediction, gameResult(802, away, home, 3, 5), {
    clv: undefined,
    closingOdds: undefined
  });
  const row = storage.readShadowLedger().find((r) => r.game_pk === '802');
  assert.equal(row.clv, null);
  assert.equal(row.closing_odds, null);

  storage.close();
});

test.after(() => {
  rmSync(resolve(process.cwd(), '.tmp-shadow-ledger-tests'), {
    recursive: true,
    force: true
  });
});
