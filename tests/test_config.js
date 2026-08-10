import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('news config is disabled by default and rejects non-positive limits', () => {
  const keys = [
    'NEWS_ENABLED',
    'NEWS_REQUEST_TIMEOUT_MS',
    'NEWS_CACHE_TTL_MINUTES',
    'NEWS_MAX_ITEMS_PER_FEED'
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.NEWS_ENABLED = '';
    process.env.NEWS_REQUEST_TIMEOUT_MS = '0';
    process.env.NEWS_CACHE_TTL_MINUTES = '-2';
    process.env.NEWS_MAX_ITEMS_PER_FEED = 'garbage';
    const config = loadConfig();
    assert.equal(config.news.enabled, false);
    assert.equal(config.news.timeoutMs, 8000);
    assert.equal(config.news.cacheTtlMs, 15 * 60 * 1000);
    assert.equal(config.news.maxItems, 25);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('config defaults moneyline edge, odds max age, and python executable safely', () => {
  const previousEdge = process.env.MINIMUM_MONEYLINE_EDGE;
  const previousOddsMaxAge = process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES;
  const previousPython = process.env.PYTHON_BIN;
  try {
    process.env.MINIMUM_MONEYLINE_EDGE = '';
    process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES = '';
    process.env.PYTHON_BIN = '';
    const config = loadConfig();
    assert.equal(config.minimumMoneylineEdge, 0.05);
    assert.equal(config.moneylineOddsMaxAgeMinutes, 10);
    assert.equal(config.pythonExecutable, 'python3');

    process.env.MINIMUM_MONEYLINE_EDGE = '0.06';
    process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES = '3';
    process.env.PYTHON_BIN = '/tmp/python';
    const overridden = loadConfig();
    assert.equal(overridden.minimumMoneylineEdge, 0.06);
    assert.equal(overridden.moneylineOddsMaxAgeMinutes, 3);
    assert.equal(overridden.pythonExecutable, '/tmp/python');
  } finally {
    if (previousEdge === undefined) delete process.env.MINIMUM_MONEYLINE_EDGE;
    else process.env.MINIMUM_MONEYLINE_EDGE = previousEdge;
    if (previousOddsMaxAge === undefined) delete process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES;
    else process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES = previousOddsMaxAge;
    if (previousPython === undefined) delete process.env.PYTHON_BIN;
    else process.env.PYTHON_BIN = previousPython;
  }
});
