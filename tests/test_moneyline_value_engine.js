import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyMoneylineValueMarket } from '../src/mlb.js';

function sampleGame(overrides = {}) {
  const base = {
    status: 'Scheduled',
    away: {
      id: 1,
      name: 'Away Underdogs',
      abbreviation: 'AWY',
      winProbability: 45,
      starter: { fullName: 'Away Starter' },
      record: { wins: 40, losses: 35, pct: '.533' }
    },
    home: {
      id: 2,
      name: 'Home Favorites',
      abbreviation: 'HOM',
      winProbability: 55,
      starter: { fullName: 'Home Starter' },
      record: { wins: 42, losses: 33, pct: '.560' }
    },
    currentOdds: {
      awayMoneyline: 160,
      homeMoneyline: -150,
      moneylineBook: 'FanDuel',
      oddsFetchedAt: new Date().toISOString()
    },
    modelBreakdown: {
      matchupEdge: 0.3,
      recordContextEdge: 0.02,
      recordDominated: false
    },
    lineups: {
      away: { confirmed: true, count: 9 },
      home: { confirmed: true, count: 9 }
    }
  };

  return {
    ...base,
    ...overrides,
    away: { ...base.away, ...overrides.away },
    home: { ...base.home, ...overrides.home },
    currentOdds: { ...base.currentOdds, ...overrides.currentOdds },
    modelBreakdown: { ...base.modelBreakdown, ...overrides.modelBreakdown },
    lineups: {
      away: { ...base.lineups.away, ...overrides.lineups?.away },
      home: { ...base.lineups.home, ...overrides.lineups?.home }
    }
  };
}

test('low-conviction underdog is downgraded to a lean, not a graded VALUE bet', () => {
  // Pre-floor this was graded VALUE off a +5.9 edge. But on 773 outcomes,
  // sub-52% conviction picks are coin flips, so betDecision stays NO BET.
  // Additionally, away team at +160 exceeds the +115 away underdog limit.
  const game = sampleGame();

  applyMoneylineValueMarket(game);

  // +160 / -150 has negative overround, so it is not a coherent same-book
  // market for fair de-vig. Use the executable side's raw implied probability
  // instead of normalizing a synthetic/arbitrage pair.
  assert.equal(game.valuePick.teamName, 'Away Underdogs');
  assert.equal(game.valuePick.modelProbability, 45);
  assert.equal(game.valuePick.impliedProbability, 38.5);
  assert.equal(game.valuePick.fairProbability, 38.5);
  assert.equal(game.valuePick.fairSource, 'raw_implied_executable');
  assert.equal(game.valuePick.edge, 6.5);
  assert.equal(game.valuePick.kellyStakePercent, 2.7);
  // ...but it is NOT graded as a bet: 45% conviction is below the 52% floor,
  // and the away underdog +160 exceeds the +115 limit.
  assert.equal(game.betDecision.status, 'NO BET');
});

test('high-conviction underdog with mispriced odds is graded VALUE when quality met', () => {
  // The profitable niche the floor preserves: model rates the market underdog
  // >=52% (conviction must clear the lowered floor) AND the team has a winning
  // record (.520+). Away +160 exceeds +115 limit but this test uses a close
  // underdog line to ensure it passes the away-dog filter too.
  const game = sampleGame({
    away: {
      id: 1,
      name: 'Away Underdogs',
      abbreviation: 'AWY',
      winProbability: 64,
      starter: { fullName: 'Away Starter' },
      record: { wins: 45, losses: 30, pct: '.600' }
    },
    currentOdds: {
      awayMoneyline: 110,
      homeMoneyline: -120,
      moneylineBook: 'FanDuel',
      oddsFetchedAt: new Date().toISOString()
    }
  });

  applyMoneylineValueMarket(game);

  assert.equal(game.valuePick.teamName, 'Away Underdogs');
  assert.equal(game.valuePick.modelProbability, 64);
  assert.equal(game.betDecision.status, 'VALUE');
  assert.ok(!game.betDecision.reasons.some((reason) => /odds moneyline/.test(reason)));
});

test('market-informed display probability does not change moneyline value edge', () => {
  const pureGame = sampleGame({
    away: {
      id: 1,
      name: 'Away Underdogs',
      abbreviation: 'AWY',
      winProbability: 64,
      pureModelProbability: 64,
      marketInformedProbability: null,
      starter: { fullName: 'Away Starter' },
      record: { wins: 45, losses: 30, pct: '.600' }
    },
    home: {
      id: 2,
      name: 'Home Favorites',
      abbreviation: 'HOM',
      winProbability: 36,
      pureModelProbability: 36,
      marketInformedProbability: null,
      starter: { fullName: 'Home Starter' },
      record: { wins: 42, losses: 33, pct: '.560' }
    },
    currentOdds: {
      awayMoneyline: 110,
      homeMoneyline: -120,
      moneylineBook: 'FanDuel',
      oddsFetchedAt: new Date().toISOString()
    },
    modelBreakdown: {
      matchupEdge: 0.3,
      recordContextEdge: 0.02,
      recordDominated: false,
      pureAwayProbability: 64,
      pureHomeProbability: 36
    }
  });
  const displayedBlendGame = sampleGame({
    away: {
      id: 1,
      name: 'Away Underdogs',
      abbreviation: 'AWY',
      winProbability: 58,
      pureModelProbability: 64,
      marketInformedProbability: 58,
      starter: { fullName: 'Away Starter' },
      record: { wins: 45, losses: 30, pct: '.600' }
    },
    home: {
      id: 2,
      name: 'Home Favorites',
      abbreviation: 'HOM',
      winProbability: 42,
      pureModelProbability: 36,
      marketInformedProbability: 42,
      starter: { fullName: 'Home Starter' },
      record: { wins: 42, losses: 33, pct: '.560' }
    },
    currentOdds: {
      awayMoneyline: 110,
      homeMoneyline: -120,
      moneylineBook: 'FanDuel',
      oddsFetchedAt: new Date().toISOString()
    },
    modelBreakdown: {
      matchupEdge: 0.3,
      recordContextEdge: 0.02,
      recordDominated: false,
      pureAwayProbability: 64,
      pureHomeProbability: 36,
      marketInformedAwayProbability: 58,
      marketInformedHomeProbability: 42
    }
  });

  assert.notEqual(pureGame.away.winProbability, displayedBlendGame.away.winProbability);

  applyMoneylineValueMarket(pureGame);
  applyMoneylineValueMarket(displayedBlendGame);

  assert.equal(pureGame.valuePick.side, 'away');
  assert.equal(displayedBlendGame.valuePick.side, 'away');
  assert.equal(pureGame.valuePick.modelProbability, 64);
  assert.equal(displayedBlendGame.valuePick.modelProbability, 64);
  assert.equal(displayedBlendGame.away.winProbability, 58);
  assert.equal(pureGame.valuePick.edge, displayedBlendGame.valuePick.edge);
  assert.equal(pureGame.betDecision.modelProbability, displayedBlendGame.betDecision.modelProbability);
  assert.equal(pureGame.betDecision.edge, displayedBlendGame.betDecision.edge);
});

test('moneyline value edge uses pure probability instead of market-blended probability', () => {
  const game = sampleGame({
    away: {
      id: 1,
      name: 'Away Favorites',
      abbreviation: 'AWY',
      winProbability: 48,
      pureModelProbability: 36,
      marketInformedProbability: 48,
      starter: { fullName: 'Away Starter' },
      record: { wins: 42, losses: 33, pct: '.560' }
    },
    home: {
      id: 2,
      name: 'Home Underdogs',
      abbreviation: 'HOM',
      winProbability: 52,
      pureModelProbability: 64,
      marketInformedProbability: 52,
      starter: { fullName: 'Home Starter' },
      record: { wins: 45, losses: 30, pct: '.600' }
    },
    currentOdds: {
      awayMoneyline: -120,
      homeMoneyline: 110,
      moneylineBook: 'FanDuel',
      oddsFetchedAt: new Date().toISOString()
    },
    modelBreakdown: {
      matchupEdge: 0.3,
      recordContextEdge: 0.02,
      recordDominated: false,
      pureAwayProbability: 36,
      pureHomeProbability: 64,
      marketBlendedAwayProbability: 48,
      marketBlendedHomeProbability: 52,
      marketInformedAwayProbability: 48,
      marketInformedHomeProbability: 52
    }
  });

  applyMoneylineValueMarket(game);

  const pureEdge = Number((game.home.pureModelProbability - game.valuePick.fairProbability).toFixed(1));
  const blendedEdge = Number((game.modelBreakdown.marketBlendedHomeProbability - game.valuePick.fairProbability).toFixed(1));

  assert.equal(game.valuePick.side, 'home');
  assert.equal(game.valuePick.modelProbability, 64);
  assert.equal(game.home.winProbability, 52);
  assert.equal(game.modelBreakdown.marketBlendedHomeProbability, 52);
  assert.equal(game.valuePick.edge, pureEdge);
  assert.notEqual(game.valuePick.edge, blendedEdge);
  assert.equal(Number((game.valuePick.edge / 100).toFixed(3)), Number(((game.home.pureModelProbability / 100) - (game.valuePick.fairProbability / 100)).toFixed(3)));
  assert.notEqual(Number((game.valuePick.edge / 100).toFixed(3)), Number(((game.modelBreakdown.marketBlendedHomeProbability / 100) - (game.valuePick.fairProbability / 100)).toFixed(3)));
});

test('missing moneyline odds timestamp downgrades otherwise valid value bet', () => {
  const game = sampleGame({
    away: {
      id: 1,
      name: 'Away Underdogs',
      abbreviation: 'AWY',
      winProbability: 64,
      starter: { fullName: 'Away Starter' },
      record: { wins: 45, losses: 30, pct: '.600' }
    },
    currentOdds: {
      awayMoneyline: 110,
      homeMoneyline: -120,
      moneylineBook: 'FanDuel',
      oddsFetchedAt: undefined,
      fetchedAt: undefined,
      updatedAt: undefined
    }
  });

  applyMoneylineValueMarket(game);

  assert.equal(game.valuePick.teamName, 'Away Underdogs');
  assert.equal(game.betDecision.status, 'NO BET');
  assert.ok(game.betDecision.reasons.includes('odds moneyline timestamp tidak tersedia'));
  assert.equal(game.betDecision.reason, 'odds moneyline timestamp tidak tersedia');
});

test('stale moneyline odds downgrade otherwise valid value bet', () => {
  const previous = process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES;
  process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES = '10';
  try {
    const game = sampleGame({
      away: {
        id: 1,
        name: 'Away Underdogs',
        abbreviation: 'AWY',
        winProbability: 64,
        starter: { fullName: 'Away Starter' },
        record: { wins: 45, losses: 30, pct: '.600' }
      },
      currentOdds: {
        awayMoneyline: 110,
        homeMoneyline: -120,
        moneylineBook: 'FanDuel',
        oddsFetchedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString()
      }
    });

    applyMoneylineValueMarket(game);

    assert.equal(game.valuePick.teamName, 'Away Underdogs');
    assert.equal(game.betDecision.status, 'NO BET');
    assert.ok(game.betDecision.reasons.some((reason) => /odds moneyline stale \d+m > 10m/.test(reason)));
  } finally {
    if (previous === undefined) delete process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES;
    else process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES = previous;
  }
});

test('moneyline value gate requires configured 5 percent edge', () => {
  // Pin the gate: default floor dropped to 0.02 (Aug 18), this test covers the
  // configured-threshold path, so force the 5% floor via env override.
  const previousEdge = process.env.MINIMUM_MONEYLINE_EDGE;
  process.env.MINIMUM_MONEYLINE_EDGE = '0.05';
  const game = sampleGame({
    away: {
      id: 1,
      name: 'Away Team',
      abbreviation: 'AWY',
      winProbability: 43,
      starter: { fullName: 'Away Starter' },
      record: { wins: 35, losses: 40, pct: '.467' }
    },
    home: {
      id: 2,
      name: 'Thin Favorite',
      abbreviation: 'THN',
      winProbability: 56,
      starter: { fullName: 'Home Starter' },
      record: { wins: 45, losses: 30, pct: '.600' }
    },
    currentOdds: {
      awayMoneyline: 110,
      homeMoneyline: -112,
      moneylineBook: 'FanDuel'
    }
  });

  try {
    applyMoneylineValueMarket(game);

    assert.equal(game.valuePick.teamName, 'Thin Favorite');
    assert.equal(game.valuePick.edge, 3.4);
    assert.equal(game.betDecision.status, 'NO BET');
    assert.ok(game.betDecision.reasons.some((reason) => /< 5\.0%/.test(reason)));
  } finally {
    if (previousEdge === undefined) delete process.env.MINIMUM_MONEYLINE_EDGE;
    else process.env.MINIMUM_MONEYLINE_EDGE = previousEdge;
  }
});

test('record dominated favorite is downgraded to no bet even with positive value', () => {
  const game = sampleGame({
    away: {
      id: 1,
      name: 'Away Team',
      abbreviation: 'AWY',
      winProbability: 36,
      starter: { fullName: 'Away Starter' },
      record: { wins: 30, losses: 45, pct: '.400' }
    },
    home: {
      id: 2,
      name: 'Record Favorite',
      abbreviation: 'REC',
      winProbability: 64,
      starter: { fullName: 'Home Starter' },
      record: { wins: 45, losses: 30, pct: '.600' }
    },
    currentOdds: {
      awayMoneyline: 125,
      homeMoneyline: -110,
      moneylineBook: 'FanDuel'
    },
    modelBreakdown: {
      rawEdge: 0.6,
      matchupEdge: 0.04,
      recordContextEdge: 0.22,
      recordDominated: true
    }
  });

  applyMoneylineValueMarket(game);

  assert.equal(game.valuePick.teamName, 'Record Favorite');
  assert.equal(game.betDecision.status, 'NO BET');
  assert.match(game.betDecision.reason, /record\/H2H/);
  // Record Favorite at -110 with model 60% has a positive raw edge, so a
  // quarter-Kelly size is still computed on the value option; the NO BET
  // downgrade is what suppresses it in /picks, not a null stake here.
  assert.equal(typeof game.valuePick.kellyStakePercent, 'number');
});

test('approved audit guardrail can downgrade weak model edge to no bet', () => {
  const previousDir = process.env.MLB_EVOLUTION_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'mlb-evolution-controls-'));
  process.env.MLB_EVOLUTION_DATA_DIR = dir;

  try {
    writeFileSync(
      join(dir, 'approved_rules.json'),
      JSON.stringify({
        active_rule_version: 'rules-v1.1',
        active_controls: [
          {
            rule_key: 'audit:no_bet:weak_edge',
            candidate_id: 'audit-safe-no-bet-weak-edge',
            type: 'no_bet_rule',
            status: 'active',
            production_update_allowed: true,
            parameters: {
              max_value_edge: 2,
              max_probability_edge: 5,
              max_matchup_edge: 0.08
            }
          }
        ],
        approved: []
      })
    );
    writeFileSync(
      join(dir, 'weight_versions.json'),
      JSON.stringify({
        active_version: 'weights-v1.0',
        versions: [{ version: 'weights-v1.0', status: 'active', weights: { moneyline: {} } }]
      })
    );

    const game = sampleGame({
      away: {
        id: 1,
        name: 'Away Team',
        abbreviation: 'AWY',
        winProbability: 48,
        starter: { fullName: 'Away Starter' },
        record: { wins: 35, losses: 40, pct: '.467' }
      },
      home: {
        id: 2,
        name: 'Thin Favorite',
        abbreviation: 'THN',
        winProbability: 52,
        starter: { fullName: 'Home Starter' },
        record: { wins: 38, losses: 37, pct: '.507' }
      },
      currentOdds: {
        awayMoneyline: -130,
        homeMoneyline: 120,
        moneylineBook: 'FanDuel'
      },
      modelBreakdown: {
        matchupEdge: 0.04,
        recordContextEdge: 0.01,
        recordDominated: false
      }
    });

    applyMoneylineValueMarket(game);

    assert.equal(game.valuePick.teamName, 'Thin Favorite');
    assert.equal(game.betDecision.status, 'NO BET');
    // The conviction floor and the audit guardrail both fire on this thin
    // favorite; assert the guardrail is among the reasons rather than first.
    assert.ok(game.betDecision.reasons.some((r) => /audit guardrail/.test(r)));
    assert.deepEqual(game.activeEvolutionVersions, { rule: 'rules-v1.1', weights: 'weights-v1.0', memory: 'audit-memory-v1.0' });
  } finally {
    if (previousDir === undefined) {
      delete process.env.MLB_EVOLUTION_DATA_DIR;
    } else {
      process.env.MLB_EVOLUTION_DATA_DIR = previousDir;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit memory adds caution notes without forcing a bet decision by itself', () => {
  const previousDir = process.env.MLB_EVOLUTION_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'mlb-audit-memory-'));
  process.env.MLB_EVOLUTION_DATA_DIR = dir;

  try {
    writeFileSync(join(dir, 'approved_rules.json'), JSON.stringify({ active_rule_version: 'rules-v1.0', active_controls: [], approved: [] }));
    writeFileSync(
      join(dir, 'weight_versions.json'),
      JSON.stringify({
        active_version: 'weights-v1.0',
        versions: [{ version: 'weights-v1.0', status: 'active', weights: { moneyline: {} } }]
      })
    );
    writeFileSync(
      join(dir, 'audit_memory.json'),
      JSON.stringify({
        version: 'audit-memory-v1.0',
        mistake_patterns: [
          {
            type: 'factor_needs_review',
            factor: 'starting_pitcher',
            caution: 'Memory: starting pitcher signal has misled recent picks.'
          }
        ],
        next_game_cautions: []
      })
    );

    const game = sampleGame({
      away: {
        id: 1,
        name: 'Away Underdogs',
        abbreviation: 'AWY',
        winProbability: 64,
        starter: { fullName: 'Away Starter' },
        record: { wins: 45, losses: 30, pct: '.600' }
      },
      modelBreakdown: {
        matchupEdge: 0.3,
        recordContextEdge: 0.02,
        starterEdge: 0.28,
        offenseEdge: 0.05,
        lineupEdge: 0.02,
        bullpenEdge: 0.01,
        recordDominated: false
      }
    });

    applyMoneylineValueMarket(game);

    // Away at +160 exceeds the away-dog limit, so it should be NO BET
    // even though conviction is high. The audit memory note should still fire.
    assert.equal(game.betDecision.status, 'NO BET');
    assert.deepEqual(game.auditMemoryNotes, ['Memory: starting pitcher signal has misled recent picks.']);
  } finally {
    if (previousDir === undefined) {
      delete process.env.MLB_EVOLUTION_DATA_DIR;
    } else {
      process.env.MLB_EVOLUTION_DATA_DIR = previousDir;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
