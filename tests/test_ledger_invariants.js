import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { Storage } from '../src/storage.js';
import { applyMigrations, migrationStatus } from '../src/storage/migrations.js';

function team(id, name, abbreviation) {
  return { id, name, abbreviation };
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
    gamePk,
    dateYmd,
    status: 'Scheduled',
    matchup: `${away.name} @ ${home.name}`,
    away: { ...away, winProbability: 45 },
    home: { ...home, winProbability: 55 },
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

function freshStorage() {
  const tempDir = resolve(process.cwd(), '.tmp-ledger-invariant-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(
    tempDir,
    `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  return { storage: new Storage(statePath), tempDir, statePath };
}

test('migrations apply and status is idempotent', () => {
  const { storage } = freshStorage();
  const status = migrationStatus(storage.db);
  assert.ok(status.skipped.length >= 1 || status.pending.length === 0);
  const second = applyMigrations(storage.db);
  assert.equal(second.applied.length, 0);
  assert.ok(
    storage.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='prediction_decisions'")
      .get()
  );
  assert.ok(
    storage.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settlements'")
      .get()
  );
  assert.ok(
    storage.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shadow_ledger'")
      .get()
  );
  assert.ok(status.skipped.includes('005_shadow_ledger'));
  storage.close();
});

test('VALUE bet settles using value team when display pick differs', () => {
  const { storage } = freshStorage();
  const away = team(146, 'Miami Marlins', 'MIA');
  const home = team(115, 'Colorado Rockies', 'COL');
  // Display/model pick = home (COL), value bet = away (MIA)
  const pred = valuePrediction(824335, '2026-07-10', away, home, 'away', {
    odds: 150,
    stake: 3.5,
    model: 58,
    fair: 50,
    teamId: 146
  });
  // Force display pick to home while value is away
  pred.pick = { ...home, winProbability: 55, confidence: 'model' };
  pred.winner = { ...home, winProbability: 55 };

  storage.savePredictions('2026-07-10', [pred]);
  const id = storage.recordBet(pred, '2026-07-10');
  assert.equal(id, '2026-07-10-moneyline-824335');

  const open = storage.getOpenBet(824335);
  assert.equal(open.side, 'away');
  assert.equal(String(open.selected_team_id), '146');
  assert.equal(open.bookmaker, 'draftkings');
  assert.equal(open.quote_id, 'q-824335-away');
  assert.ok(open.decision_hash);

  // Away (value) wins → win even though display pick was home
  storage.settleBet(pred, gameResult(824335, away, home, 6, 2), 1.2);
  const row = storage.readLedger()[0];
  assert.equal(row.status, 'settled');
  assert.equal(row.result, 'win');
  assert.equal(row.units_pl, 5.25); // 3.5 * 1.5
  assert.equal(row.clv, 1.2);
  assert.equal(String(row.selected_team_id), '146');

  const settlement = storage.db
    .prepare('SELECT * FROM settlements WHERE game_pk = ?')
    .get('824335');
  assert.ok(settlement);
  assert.equal(String(settlement.selected_team_id), '146');
  assert.equal(settlement.selected_side, 'away');
  storage.close();
});

test('processPostGameOutcome is atomic: no process mark if settle cannot complete open bet path', () => {
  const { storage } = freshStorage();
  const away = team(1, 'Aces', 'ACE');
  const home = team(2, 'Bats', 'BAT');
  const pred = valuePrediction(99, '2026-07-11', away, home, 'away', {
    odds: 100,
    stake: 2,
    model: 58,
    fair: 50
  });
  storage.savePredictions('2026-07-11', [pred]);
  storage.recordBet(pred, '2026-07-11');

  const result = gameResult(99, away, home, 5, 1);
  const out = storage.processPostGameOutcome(pred, result, { enabled: true, clv: 0.5 });
  assert.equal(out.processed, true);
  assert.equal(out.settled, true);

  const pick = storage.getPrediction(99);
  assert.equal(pick.postGameProcessed, true);
  assert.equal(storage.getOpenBet(99), null);
  assert.equal(storage.readLedger()[0].status, 'settled');
  storage.close();
});

test('processPostGameOutcome does not double-count memory on retry', () => {
  const { storage } = freshStorage();
  const away = team(1, 'Aces', 'ACE');
  const home = team(2, 'Bats', 'BAT');
  const pred = valuePrediction(100, '2026-07-12', away, home, 'home', {
    odds: -110,
    stake: 2,
    model: 56,
    fair: 50
  });
  storage.savePredictions('2026-07-12', [pred]);
  storage.recordBet(pred, '2026-07-12');

  // Simulate stranded: mark processed without settling (old bug path)
  storage.recordOutcome(pred, gameResult(100, away, home, 1, 4), { enabled: true });
  assert.equal(storage.getPrediction(100).postGameProcessed, true);
  assert.ok(storage.getOpenBet(100));

  const memAfterFirst = storage.getMemory();
  const totalAfterFirst = memAfterFirst.totalPicks;

  // Recovery path: processPostGameOutcome should settle stranded open bet without double memory
  const out = storage.processPostGameOutcome(pred, gameResult(100, away, home, 1, 4), {
    enabled: true,
    clv: 0.1
  });
  assert.equal(out.settled, true);
  assert.equal(out.retriedStranded, true);
  assert.equal(storage.getOpenBet(100), null);
  assert.equal(storage.getMemory().totalPicks, totalAfterFirst);
  storage.close();
});

test('recordBet persists selected_team_id and getLedgerSide prefers ledger over display pick', () => {
  const { storage } = freshStorage();
  const away = team(10, 'Away', 'AWY');
  const home = team(20, 'Home', 'HOM');
  const pred = valuePrediction(55, '2026-07-13', away, home, 'away', {
    odds: 140,
    stake: 1.5,
    model: 57,
    fair: 50,
    teamId: 10
  });
  pred.pick = { ...home, winProbability: 55, confidence: 'analyst-agent' };
  storage.savePredictions('2026-07-13', [pred]);
  storage.recordBet(pred, '2026-07-13');
  assert.equal(storage.getLedgerSide(55), 'away');
  storage.close();
});

test('settleBet is idempotent and requires changes === 1', () => {
  const { storage } = freshStorage();
  const away = team(1, 'Aces', 'ACE');
  const home = team(2, 'Bats', 'BAT');
  const pred = valuePrediction(77, '2026-07-14', away, home, 'away', {
    odds: 200,
    stake: 1,
    model: 55,
    fair: 48
  });
  storage.savePredictions('2026-07-14', [pred]);
  storage.recordBet(pred, '2026-07-14');
  assert.equal(storage.settleBet(pred, gameResult(77, away, home, 3, 1), 0.2), true);
  const pl = storage.readLedger()[0].units_pl;
  assert.equal(storage.settleBet(pred, gameResult(77, away, home, 3, 1), 9.9), false);
  assert.equal(storage.readLedger()[0].units_pl, pl);
  assert.equal(storage.readLedger()[0].clv, 0.2);
  storage.close();
});

test.after(() => {
  rmSync(resolve(process.cwd(), '.tmp-ledger-invariant-tests'), {
    recursive: true,
    force: true
  });
});
