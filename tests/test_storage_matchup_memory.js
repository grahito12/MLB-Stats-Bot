import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { Storage } from '../src/storage.js';

function team(id, name, abbreviation) {
  return { id, name, abbreviation };
}

function prediction(gamePk, dateYmd, away, home, pick) {
  return {
    gamePk,
    dateYmd,
    matchup: `${away.name} @ ${home.name}`,
    away,
    home,
    pick: {
      ...pick,
      winProbability: 58,
      confidence: 'medium'
    },
    firstInning: {
      pick: 'NO',
      probability: 54
    }
  };
}

function result(gamePk, dateYmd, away, home, awayScore, homeScore) {
  const winner = awayScore > homeScore ? away : home;
  const loser = awayScore > homeScore ? home : away;

  return {
    gamePk,
    dateYmd,
    away: { ...away, score: awayScore },
    home: { ...home, score: homeScore },
    winner,
    loser,
    firstInning: {
      anyRun: false
    }
  };
}

test('recordOutcome stores matchup memory across reversed venues', () => {
  const tempDir = resolve(process.cwd(), '.tmp-storage-tests');
  mkdirSync(tempDir, { recursive: true });
  const statePath = resolve(tempDir, `state-${Date.now()}.json`);
  const storage = new Storage(statePath);
  const alpha = team(100, 'Alpha Aces', 'AAA');
  const beta = team(200, 'Beta Bats', 'BBB');

  storage.recordOutcome(
    prediction(1, '2026-04-01', alpha, beta, beta),
    result(1, '2026-04-01', alpha, beta, 2, 5)
  );
  storage.recordOutcome(
    prediction(2, '2026-04-02', beta, alpha, alpha),
    result(2, '2026-04-02', beta, alpha, 6, 3)
  );

  try {
    const memory = storage.getMemory();
    const entry = memory.matchupMemory['100:200'];

    assert.equal(memory.totalPicks, 2);
    assert.equal(Object.keys(memory.matchupMemory).length, 1);
    assert.equal(entry.totalGames, 2);
    assert.equal(entry.recentGames.length, 2);
    assert.equal(entry.teamRecords['200'].wins, 2);
    assert.equal(entry.pickStats.total, 2);
    assert.equal(entry.pickStats.correct, 1);
    assert.equal(entry.currentStreak.winner.id, 200);
    assert.equal(entry.currentStreak.length, 2);
    assert.match(entry.note, /menang 2 pertemuan terakhir/);

    const summary = storage.getMemorySummary();
    assert.equal(summary.matchupMemory.totalMatchups, 1);
    assert.equal(summary.matchupMemory.recent[0].key, '100:200');
  } finally {
    rmSync(statePath, { force: true });
  }
});
