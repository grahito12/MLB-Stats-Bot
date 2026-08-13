import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTopPicksAnswer, normalizeInteractiveAnswer } from '../src/llm.js';

function prediction(gamePk, awayName, homeName, awayProbability, homeProbability, reason, overrides = {}) {
  const away = {
    id: gamePk * 10 + 1,
    name: awayName,
    abbreviation: awayName.slice(0, 3).toUpperCase(),
    winProbability: awayProbability,
    starterLine: `${awayName} starter edge`
  };
  const home = {
    id: gamePk * 10 + 2,
    name: homeName,
    abbreviation: homeName.slice(0, 3).toUpperCase(),
    winProbability: homeProbability,
    starterLine: `${homeName} starter edge`
  };
  const winner = homeProbability >= awayProbability ? home : away;

  return {
    gamePk,
    away,
    home,
    winner,
    reasons: [reason],
    modelBreakdown: {
      matchupEdge: 0.2,
      recordContextEdge: 0.04,
      recordDominated: false
    },
    betDecision: {
      status: 'LEAN ONLY',
      edge: 0
    },
    ...overrides
  };
}

test('interactive answer normalization removes hidden reasoning tags', () => {
  const answer = normalizeInteractiveAnswer(
    '<think>long private ranking process</think>\nTop 5 Pick Model Hari Ini\n1. BAL ML - prediksi menang: Baltimore Orioles.'
  );

  assert.doesNotMatch(answer, /<think>/i);
  assert.doesNotMatch(answer, /private ranking/i);
  assert.match(answer, /Top 5 Pick Model Hari Ini/);
});

test('top 5 pick question uses concise deterministic formatter', () => {
  const predictions = [
    prediction(1, 'Away One', 'Home One', 45, 55, 'Home One punya starter dan offense lebih stabil.'),
    prediction(2, 'Away Two', 'Home Two', 63, 37, 'Away Two unggul run prevention hari ini.'),
    prediction(3, 'Away Three', 'Home Three', 40, 60, 'Home Three didukung bullpen lebih segar.'),
    prediction(4, 'Away Four', 'Home Four', 58, 42, 'Away Four punya matchup edge dari starter.'),
    prediction(5, 'Away Five', 'Home Five', 35, 65, 'Home Five unggul offense dan park context.'),
    prediction(6, 'Away Six', 'Home Six', 51, 49, 'Away Six hanya edge tipis.')
  ];

  const answer = buildTopPicksAnswer(predictions, 'best 5 top pick for today');

  assert.match(answer, /Top Pick Model \| Hari Ini/);
  assert.match(answer, /Prediksi \|/);
  assert.match(answer, /Keyakinan \|/);
  assert.match(answer, /Konfirmasi \|/);
  assert.match(answer, /Alasan \|/);
  assert.match(answer, /5\. /);
  assert.doesNotMatch(answer, /6\. /);
  assert.doesNotMatch(answer, /RISK:/i);
  assert.doesNotMatch(answer, /<think>/i);
});

test('top picks filters out a coinflip pick below the quality threshold', () => {
  const predictions = [
    prediction(1, 'Away One', 'Home One', 38, 62, 'Home One starter dominan.'),
    prediction(2, 'Away Two', 'Home Two', 64, 36, 'Away Two run prevention unggul.'),
    prediction(3, 'Coin Away', 'Coin Home', 50, 50, 'Murni coinflip tanpa edge.')
  ];

  const answer = buildTopPicksAnswer(predictions, 'best 5 top pick for today');
  // The 50/50 game carries no edge and must be excluded from the surfaced list.
  assert.doesNotMatch(answer, /Coin (Away|Home)/);
});

test('optional external news display does not change model ranking or probability', () => {
  const withNews = prediction(1, 'Away One', 'Home One', 40, 60, 'Home One model edge.', {
    newsContext: {
      status: 'ok',
      articles: [{ sourceName: 'MLB', title: 'Away One roster update' }]
    }
  });
  const stronger = prediction(2, 'Away Two', 'Home Two', 65, 35, 'Away Two model edge.');
  const answer = buildTopPicksAnswer(
    [withNews, stronger],
    'best 5 top pick for today',
    5,
    null,
    { includeNews: true }
  );
  assert.match(answer, /External \| \[MLB\] Away One roster update/);
  const firstPickHeader = answer.split('\n').find((line) => /^1\./.test(line.trim())) || '';
  assert.match(firstPickHeader, /AWA ML/);
  assert.match(answer, /Away Two menang  \|  65%/);
  assert.match(answer, /Home One menang  \|  60%/);
});

test('mixed slate labels edge tipis fallbacks honestly', () => {
  // One quality VALUE pick + several NO BET picks (all non-coinflip so they
  // fill the remaining slots). The header must disclose the thin-edge picks
  // instead of hiding their status.
  const predictions = [
    prediction(1, 'Value Away', 'Value Home', 66, 34, 'Value Away unggul jelas.', {
      betDecision: { status: 'VALUE', edge: 5, teamName: 'Value Away' },
      agentAnalysis: { pickTeamId: 11, confidence: 'high' }
    }),
    prediction(2, 'Nobet Away', 'Nobet Home', 54, 46, 'Edge tipis.', {
      betDecision: { status: 'NO BET', edge: 0.5 }
    }),
    prediction(3, 'Skip Away', 'Skip Home', 53, 47, 'Edge tipis.', {
      betDecision: { status: 'NO BET', edge: 0.5 }
    })
  ];

  const answer = buildTopPicksAnswer(predictions, 'best 5 top pick for today');
  const header = answer.split('\n').find((line) => line.includes('⚠️')) || '';
  assert.match(header, /edge tipis/);
});
