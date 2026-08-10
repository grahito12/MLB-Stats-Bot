import assert from 'node:assert/strict';
import test from 'node:test';

import {
  summarizeClv,
  clvGateReason,
  applyClvGateToPrediction,
  DEFAULT_CLV_GATE
} from '../src/clv_gate.js';
import { formatLedgerReport } from '../src/ledgerReport.js';
import { applyMoneylineValueMarket } from '../src/mlb.js';

function sampleGame(overrides = {}) {
  return {
    gamePk: 910001,
    dateYmd: '2026-08-10',
    status: 'Scheduled',
    matchup: 'Away Team @ Home Team',
    away: {
      id: 1,
      name: 'Away Team',
      abbreviation: 'AWY',
      winProbability: 40,
      starter: { fullName: 'Away Starter' },
      record: { wins: 30, losses: 45, pct: '.400' }
    },
    home: {
      id: 2,
      name: 'Home Team',
      abbreviation: 'HOM',
      winProbability: 64,
      starter: { fullName: 'Home Starter' },
      record: { wins: 45, losses: 30, pct: '.600' }
    },
    winner: {
      id: 2,
      name: 'Home Team',
      abbreviation: 'HOM',
      winProbability: 64
    },
    pick: {
      id: 2,
      name: 'Home Team',
      abbreviation: 'HOM',
      winProbability: 64,
      confidence: 'model'
    },
    currentOdds: {
      awayMoneyline: 150,
      homeMoneyline: -130,
      moneylineBook: 'FanDuel',
      oddsFetchedAt: new Date().toISOString()
    },
    modelBreakdown: {
      rawEdge: 0.6,
      matchupEdge: 0.3,
      recordContextEdge: 0.02,
      recordDominated: false,
      starterEdge: 0.2,
      offenseEdge: 0.1,
      bullpenEdge: 0.05,
      lineupEdge: 0.05
    },
    ...overrides
  };
}

test('summarizeClv averages settled moneyline CLV only', () => {
  const rows = [
    { status: 'open', market: 'moneyline', clv: 9 },
    { status: 'settled', market: 'totals', clv: 5 },
    { status: 'settled', market: 'moneyline', clv: -1 },
    { status: 'settled', market: 'moneyline', clv: 1 },
    { status: 'settled', market: 'moneyline', clv: null },
    { status: 'settled', market: 'moneyline', clv: -0.5 }
  ];
  const summary = summarizeClv(rows, { lookback: 50 });
  assert.equal(summary.sample, 3);
  // summarizeClv rounds avg to 3 decimals
  assert.equal(summary.avgClv, -0.167);
  assert.equal(summary.positive, 1);
  assert.equal(summary.negative, 2);
});

test('clvGateReason blocks only with enough sample and negative avg', () => {
  assert.equal(clvGateReason({ sample: 10, avgClv: -1 }, DEFAULT_CLV_GATE), null);
  assert.equal(clvGateReason({ sample: 20, avgClv: 0.1 }, DEFAULT_CLV_GATE), null);
  assert.equal(clvGateReason({ sample: 20, avgClv: 0 }, DEFAULT_CLV_GATE), null);
  const reason = clvGateReason({ sample: 20, avgClv: -0.67 }, DEFAULT_CLV_GATE);
  assert.match(reason, /rolling avg CLV -0\.67/);
  assert.match(reason, /n=20/);
  assert.equal(
    clvGateReason({ sample: 50, avgClv: -1 }, { ...DEFAULT_CLV_GATE, enabled: false }),
    null
  );
});

test('applyClvGateToPrediction downgrades VALUE without changing edge math', () => {
  const game = sampleGame();
  applyMoneylineValueMarket(game);
  // Ensure we start from VALUE (edge well above floor).
  assert.equal(game.betDecision.status, 'VALUE');
  const edgeBefore = game.betDecision.edge;
  const modelProbBefore = game.betDecision.modelProbability;
  const pureHomeBefore = game.home.winProbability;

  const summary = { sample: 25, avgClv: -0.8 };
  applyClvGateToPrediction(game, summary, DEFAULT_CLV_GATE);
  assert.equal(game.betDecision.status, 'NO BET');
  assert.match(game.betDecision.reason, /rolling avg CLV/);
  assert.equal(game.betDecision.edge, edgeBefore);
  assert.equal(game.betDecision.modelProbability, modelProbBefore);
  assert.equal(game.home.winProbability, pureHomeBefore);
  assert.equal(game.betDecision.clvGate.blocked, true);
});

test('applyClvGateToPrediction is no-op when sample thin or avg non-negative', () => {
  const game = sampleGame();
  applyMoneylineValueMarket(game);
  assert.equal(game.betDecision.status, 'VALUE');
  applyClvGateToPrediction(game, { sample: 5, avgClv: -2 }, DEFAULT_CLV_GATE);
  assert.equal(game.betDecision.status, 'VALUE');
  applyClvGateToPrediction(game, { sample: 30, avgClv: 0.2 }, DEFAULT_CLV_GATE);
  assert.equal(game.betDecision.status, 'VALUE');
});

test('formatLedgerReport includes avg CLV and gate status', () => {
  const rows = [];
  for (let i = 0; i < 22; i += 1) {
    rows.push({
      status: 'settled',
      market: 'moneyline',
      team: `T${i}`,
      odds: -110,
      edge: 6,
      units_staked: 1,
      units_pl: i % 2 === 0 ? 0.9 : -1,
      result: i % 2 === 0 ? 'win' : 'loss',
      clv: -0.5
    });
  }
  rows.push({
    status: 'open',
    market: 'moneyline',
    team: 'Open',
    odds: 120,
    edge: 7,
    units_staked: 2,
    date_ymd: '2026-08-10'
  });
  const out = formatLedgerReport(rows, { clvGate: DEFAULT_CLV_GATE });
  assert.match(out, /CLV \(moneyline\)/);
  assert.match(out, /Avg CLV \| -0\.50 \(n=22/);
  assert.match(out, /VALUE gate \| BLOCK/);
});
