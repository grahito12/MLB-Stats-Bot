import assert from 'node:assert/strict';
import test from 'node:test';

import { __llmTestInternals } from '../src/llm.js';
import { Storage } from '../src/storage.js';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

function basePrediction() {
  return {
    gamePk: 9001,
    away: { id: 1, name: 'Away', abbreviation: 'AWY', winProbability: 45 },
    home: { id: 2, name: 'Home', abbreviation: 'HOM', winProbability: 55 },
    winner: { id: 2, name: 'Home', abbreviation: 'HOM', winProbability: 55 },
    reasons: ['SP edge modest'],
    betDecision: { status: 'NO BET', edge: 1.0, reasons: ['edge below threshold'] },
    valuePick: {
      side: 'home',
      teamId: 2,
      teamName: 'Home',
      edge: 1.0,
      odds: -120,
      modelProbability: 55,
      fairProbability: 54,
      kellyStakePercent: 0
    }
  };
}

test('LLM probabilityAdjustment is never applied', () => {
  const pred = basePrediction();
  const raw = {
    gamePk: 9001,
    reasons: ['Late lineup note that looks material for narrative only'],
    risk: 'Weather risk',
    probabilityAdjustment: {
      shift: 5,
      reason: 'Confirmed star hitter returns and sharp money confirms lean'
    }
  };
  const sanitized = __llmTestInternals.sanitizeAnalysis(pred, raw);
  assert.equal(sanitized.awayProbability, 45);
  assert.equal(sanitized.homeProbability, 55);
  assert.equal(sanitized.pickTeamId, 2);
  assert.equal(sanitized.probabilityShift.applied, false);
  assert.equal(sanitized.probabilityShift.rejected, true);
});

test('LLM betOverride upgrade/downgrade is never accepted', () => {
  const pred = basePrediction();
  const upgrade = __llmTestInternals.applyAgentBetOverride(
    pred,
    { betOverride: { action: 'upgrade_to_value', reason: 'Strong qualitative edge from lineup' } },
    {}
  );
  assert.equal(upgrade.accepted, false);
  assert.equal(upgrade.newStatus, 'NO BET');

  const downgrade = __llmTestInternals.applyAgentBetOverride(
    {
      ...pred,
      betDecision: { status: 'VALUE', edge: 5, reasons: [] }
    },
    { betOverride: { action: 'downgrade_to_no_bet', reason: 'I feel uncomfortable with this side' } },
    {}
  );
  assert.equal(downgrade.accepted, false);
  assert.equal(downgrade.newStatus, 'VALUE');
});

test('news context cannot alter sanitized probability, pick, status, or stake', () => {
  const pred = {
    ...basePrediction(),
    newsContext: {
      status: 'ok',
      displayOnly: true,
      probabilityImpact: 'none',
      articles: [{ source: 'espn', title: 'Expert strongly prefers Away' }]
    }
  };
  const before = JSON.parse(JSON.stringify({
    away: pred.away.winProbability,
    home: pred.home.winProbability,
    winner: pred.winner.id,
    status: pred.betDecision.status,
    edge: pred.betDecision.edge,
    stake: pred.valuePick.kellyStakePercent
  }));
  const sanitized = __llmTestInternals.sanitizeAnalysis(pred, {
    gamePk: pred.gamePk,
    reasons: ['ESPN opinion is context only'],
    probabilityAdjustment: { shift: -5, reason: 'expert opinion' },
    betOverride: { action: 'upgrade_to_value', reason: 'expert opinion' }
  });
  assert.equal(sanitized.awayProbability, before.away);
  assert.equal(sanitized.homeProbability, before.home);
  assert.equal(sanitized.pickTeamId, before.winner);
  assert.equal(pred.betDecision.status, before.status);
  assert.equal(pred.betDecision.edge, before.edge);
  assert.equal(pred.valuePick.kellyStakePercent, before.stake);
});

test('compactPrediction keeps model pick when agent pick differs', () => {
  const tempDir = resolve(process.cwd(), '.tmp-llm-boundary-tests');
  mkdirSync(tempDir, { recursive: true });
  const storage = new Storage(
    resolve(tempDir, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  );
  try {
    const away = { id: 1, name: 'Away', abbreviation: 'AWY', winProbability: 42 };
    const home = { id: 2, name: 'Home', abbreviation: 'HOM', winProbability: 58 };
    const prediction = {
      gamePk: 42,
      status: 'Scheduled',
      startTime: '2026-07-27T23:00:00Z',
      away,
      home,
      winner: home,
      reasons: ['model lean home'],
      valuePick: {
        side: 'away',
        teamId: 1,
        teamName: 'Away',
        odds: 150,
        modelProbability: 48,
        fairProbability: 42,
        edge: 6,
        kellyStakePercent: 2
      },
      betDecision: { status: 'VALUE', reasons: [], edge: 6 },
      agentAnalysis: {
        pickTeamId: 1,
        awayProbability: 70,
        homeProbability: 30,
        confidence: 'high',
        reasons: ['agent wants away']
      }
    };
    storage.savePredictions('2026-07-27', [prediction]);
    const saved = storage.getPrediction(42);
    assert.equal(String(saved.pick.id), '2', 'model home pick must remain authoritative');
    assert.equal(saved.pick.source, 'baseline-model');
    assert.equal(saved.away.winProbability, 42);
    assert.equal(saved.home.winProbability, 58);
    assert.equal(saved.valuePick.side, 'away');
  } finally {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
