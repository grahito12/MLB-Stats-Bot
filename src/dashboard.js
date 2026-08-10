import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { applyMoneylineValueMarket, confidenceBand, getMlbPredictions } from './mlb.js';
import { applyClvGateToPrediction, summarizeClv } from './clv_gate.js';
import { attachCurrentOdds } from './lineMovement.js';
import { attachNewsContext, persistNewsFeatureSnapshots } from './news.js';
import { Storage } from './storage.js';
import { dateInTimezone, toNumber } from './utils.js';

let config = null;
let storage = null;
let port = 3008;
let host = '0.0.0.0';
const rootDir = resolve(process.cwd(), 'dashboard');
let packageJson = null;
let activeServer = null;

function ensureInitialized() {
  if (config) return;
  config = loadConfig();
  storage = new Storage();
  port = config.dashboard?.port || 3008;
  host = config.dashboard?.host || '0.0.0.0';
  try {
    packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
  } catch {
    packageJson = { name: 'mlb-alert-telegram-agent', version: '0.0.0' };
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, message, detail = '') {
  sendJson(response, statusCode, { error: message, detail });
}

function dashboardApiToken() {
  return (process.env.DASHBOARD_API_TOKEN || '').trim();
}

function isLoopbackHost(value) {
  return ['127.0.0.1', 'localhost', '::1', ''].includes(String(value || '').trim());
}

function isAuthorized(request) {
  const expected = dashboardApiToken();
  if (!expected) return true;
  const authorization = request.headers.authorization || '';
  const [scheme, supplied] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' && supplied?.trim() === expected;
}

function safeBoolean(value) {
  return Boolean(value && String(value).trim());
}

function parseBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 1024 * 128) {
        rejectBody(new Error('Request body too large'));
      }
    });
    request.on('end', () => {
      if (!body) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(body));
      } catch (error) {
        rejectBody(error);
      }
    });
  });
}

function runPython(args, { timeoutMs = 45000 } = {}) {
  ensureInitialized();
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(config.pythonExecutable, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(new Error('Python command timeout'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectRun(new Error((stderr || stdout || `Python exited with ${code}`).trim()));
        return;
      }
      resolveRun(stdout.trim());
    });
  });
}

async function runPythonJson(code, args = []) {
  const stdout = await runPython(['-c', code, ...args]);
  return JSON.parse(stdout || '{}');
}

async function sampleGames() {
  return runPythonJson(
    [
      'import json',
      'from src.agent_tools import get_today_games',
      'print(json.dumps({"games": get_today_games(use_live=False)}, default=str))',
    ].join('\n')
  );
}

async function sampleAnalysis(gameId) {
  return runPythonJson(
    [
      'import json, sys',
      'from src.agent_tools import get_game_context, predict_moneyline, explain_prediction',
      'gid = sys.argv[1]',
      'payload = {',
      '  "context": get_game_context(gid),',
      '  "moneyline": predict_moneyline(gid),',
      '  "full_text": explain_prediction(gid),',
      '}',
      'print(json.dumps(payload, default=str))',
    ].join('\n'),
    [String(gameId)]
  );
}

async function knowledgeAnswer(question) {
  return runPythonJson(
    [
      'import json, sys',
      'from src.knowledge.baseball_knowledge import answer_baseball_question',
      'question = " ".join(sys.argv[1:])',
      'print(json.dumps(answer_baseball_question(question), default=str))',
    ].join('\n'),
    [question]
  );
}

async function evaluationReport() {
  return runPythonJson(
    [
      'import json',
      'from src.evaluate import load_prediction_log, calculate_metrics, build_report, performance_by_confidence, performance_by_market_total',
      'rows = load_prediction_log()',
      'payload = {',
      '  "rows": rows,',
      '  "metrics": calculate_metrics(rows),',
      '  "by_confidence": performance_by_confidence(rows),',
      '  "by_market_total": performance_by_market_total(rows),',
      '  "report": build_report(rows),',
      '}',
      'print(json.dumps(payload, default=str))',
    ].join('\n')
  );
}

async function runBacktest(body) {
  const market = body.market === 'moneyline' ? body.market : 'moneyline';
  const season = Number.isFinite(Number(body.season)) ? String(Number(body.season)) : '2025';
  const output = await runPython(['-m', 'src.backtest', '--season', season, '--market', market], {
    timeoutMs: 60000,
  });
  const evaluation = await evaluationReport();
  return { output, evaluation };
}

function liveDisplayProbabilities(prediction) {
  return {
    away: Math.round(prediction.away?.winProbability ?? 50),
    home: Math.round(prediction.home?.winProbability ?? 50),
  };
}

function livePick(prediction, probabilities) {
  if (prediction.winner?.id === prediction.away?.id) return prediction.away;
  if (prediction.winner?.id === prediction.home?.id) return prediction.home;
  return probabilities.home >= probabilities.away ? prediction.home : prediction.away;
}

function liveGameState(status) {
  const value = String(status || '').toLowerCase();
  if (value.includes('final') || value.includes('game over') || value.includes('completed')) return 'final';
  if (
    value.includes('progress') ||
    value.includes('live') ||
    value.includes('inning') ||
    value.includes('delayed')
  ) {
    return 'live';
  }
  if (value.includes('postponed') || value.includes('cancel') || value.includes('suspended')) return 'off';
  return 'scheduled';
}

function splitDashboardLine(value) {
  return String(value || '')
    .split(' | ')
    .map((item) => item.trim())
    .filter(Boolean);
}

function fieldStatus(label, status, detail = '') {
  return { label, status, detail };
}

function liveQualityReport(prediction, fetchedAt) {
  let score = 0;
  const awayStarter = prediction.away?.starterLine || '';
  const homeStarter = prediction.home?.starterLine || '';
  const awayLineup = prediction.lineups?.away;
  const homeLineup = prediction.lineups?.home;
  const probablePitchersConfirmed =
    awayStarter && homeStarter && !awayStarter.includes('TBD') && !homeStarter.includes('TBD');
  const lineupConfirmed = awayLineup?.confirmed && homeLineup?.confirmed;
  const lineupPartial = Boolean(awayLineup || homeLineup);
  const weatherAvailable = Boolean(prediction.weather);
  const bullpenAvailable = Boolean(prediction.bullpenLine);
  const parkAvailable = Boolean(prediction.parkFactor);
  const marketOddsAvailable = Boolean(
    prediction.currentOdds?.homeMoneyline != null || prediction.currentOdds?.awayMoneyline != null
  );
  const injuryAvailable = Boolean(prediction.injuryDetailLines?.length || prediction.injuryLine);
  const missingFields = [];
  const confidenceAdjustments = [];

  if (probablePitchersConfirmed) {
    score += 20;
  } else {
    missingFields.push('probable pitchers');
    confidenceAdjustments.push('probable pitcher missing or TBD');
  }
  if (lineupConfirmed) {
    score += 15;
  } else if (lineupPartial) {
    score += 7;
    confidenceAdjustments.push('lineup not fully confirmed');
  } else {
    missingFields.push('confirmed lineup');
    confidenceAdjustments.push('lineup missing');
  }
  if (weatherAvailable) score += 10;
  else missingFields.push('weather');
  if (bullpenAvailable) score += 15;
  else missingFields.push('bullpen usage');
  if (parkAvailable) score += 10;
  else missingFields.push('park factor');
  if (marketOddsAvailable) score += 10;
  else missingFields.push('market odds');
  if (injuryAvailable) score += 5;
  else missingFields.push('injury context');

  const fields = {
    probablePitchers: fieldStatus(
      'Probable pitchers',
      probablePitchersConfirmed ? 'Confirmed' : 'Missing/TBD',
      `${prediction.away?.abbreviation || prediction.away?.name || 'Away'}: ${awayStarter || 'TBD'} | ${
        prediction.home?.abbreviation || prediction.home?.name || 'Home'
      }: ${homeStarter || 'TBD'}`
    ),
    lineup: fieldStatus(
      'Lineup',
      lineupConfirmed ? 'Confirmed' : lineupPartial ? 'Projected/partial' : 'Missing',
      prediction.lineupLine || 'Lineup not available yet'
    ),
    weather: fieldStatus(
      'Weather',
      weatherAvailable ? 'Available' : 'Missing',
      weatherAvailable ? 'Weather data available' : 'No weather adjustment found'
    ),
    odds: fieldStatus(
      'Market odds',
      'Unavailable',
      'Live Odds API is optional; dashboard will not invent market odds.'
    ),
    bullpen: fieldStatus('Bullpen usage', bullpenAvailable ? 'Available' : 'Missing', prediction.bullpenLine || ''),
    park: fieldStatus(
      'Park factor',
      parkAvailable ? 'Available' : 'Missing',
      prediction.parkFactor
        ? `${prediction.parkFactor.label} (run factor ${prediction.parkFactor.runFactorPct}%)`
        : ''
    ),
    marketOdds: fieldStatus(
      'Market odds',
      marketOddsAvailable ? 'Available' : 'Missing',
      marketOddsAvailable
        ? `Current moneyline: ${prediction.away?.abbreviation || 'Away'} ${
            prediction.currentOdds?.awayMoneyline ?? 'N/A'
          } | ${prediction.home?.abbreviation || 'Home'} ${prediction.currentOdds?.homeMoneyline ?? 'N/A'}`
        : ''
    ),
  };

  return {
    score: Math.min(100, score),
    note:
      'Live slate comes from MLB StatsAPI. Odds are only live when an optional odds provider is configured.',
    fields,
    missingFields,
    staleFields: [],
    confidenceAdjustments,
    fetchedAt,
  };
}

function summarizeValueDecision(prediction) {
  const decision = prediction.betDecision;
  if (!decision) return null;

  // The model's favored side and its calibrated win probability drives the
  // confidence band shown to the reader, independent of which side the
  // edge-based value option lands on (mirrors mlb.js modelPickSide).
  const awayProbability = toNumber(prediction.away?.winProbability, 0);
  const homeProbability = toNumber(prediction.home?.winProbability, 0);
  const modelSide = homeProbability >= awayProbability
    ? { team: prediction.home?.name, percent: homeProbability }
    : { team: prediction.away?.name, percent: awayProbability };
  const valuePick = prediction.valuePick || null;

  return {
    status: decision.status,
    teamName: decision.teamName ?? valuePick?.teamName ?? null,
    teamAbbreviation: decision.teamAbbreviation ?? valuePick?.teamAbbreviation ?? null,
    odds: decision.odds ?? valuePick?.odds ?? null,
    book: decision.book ?? valuePick?.book ?? null,
    modelProbability: decision.modelProbability ?? valuePick?.modelProbability ?? null,
    impliedProbability: decision.impliedProbability ?? valuePick?.impliedProbability ?? null,
    edge: decision.edge ?? valuePick?.edge ?? null,
    kellyStakePercent: valuePick?.kellyStakePercent ?? null,
    reason: decision.reason || '',
    reasons: decision.reasons || [],
    modelSide: modelSide.team,
    modelSideProbability: Math.round(modelSide.percent),
    confidenceBand: confidenceBand(modelSide.percent),
  };
}

function summarizeLivePrediction(prediction, meta = {}) {
  const probabilities = liveDisplayProbabilities(prediction);
  const pick = livePick(prediction, probabilities);
  const pickProbability = pick?.id === prediction.away?.id ? probabilities.away : probabilities.home;
  const agentActive = Boolean(prediction.agentAnalysis);

  return {
    game_id: String(prediction.gamePk),
    source: 'MLB StatsAPI live',
    sourceMode: 'live',
    date: meta.dateYmd,
    updatedAt: meta.fetchedAt,
    status: prediction.status,
    gameState: liveGameState(prediction.status),
    start: prediction.start,
    venue: prediction.venue,
    away_team: prediction.away?.name,
    home_team: prediction.home?.name,
    away_abbreviation: prediction.away?.abbreviation,
    home_abbreviation: prediction.home?.abbreviation,
    matchup: `${prediction.away?.name} @ ${prediction.home?.name}`,
    probabilities: {
      away: probabilities.away,
      home: probabilities.home,
    },
    pick: {
      name: pick?.name,
      probability: pickProbability,
      confidence: prediction.agentAnalysis?.confidence || 'model',
      source: agentActive ? 'Analyst Agent + deterministic model' : 'Deterministic model',
    },
    value: summarizeValueDecision(prediction),
    starters: {
      away: prediction.away?.starterLine || 'TBD',
      home: prediction.home?.starterLine || 'TBD',
      awayEra: prediction.away?.starterEra ?? null,
      homeEra: prediction.home?.starterEra ?? null,
    },
    quality: liveQualityReport(prediction, meta.fetchedAt),
    context: {
      standings: splitDashboardLine(prediction.contextLine),
      splits: splitDashboardLine(prediction.matchupSplitLine),
      advanced: splitDashboardLine(prediction.advancedLine),
      pitcherRecent: splitDashboardLine(prediction.pitcherRecentLine),
      bullpen: splitDashboardLine(prediction.bullpenLine),
      injuries: prediction.injuryDetailLines || splitDashboardLine(prediction.injuryLine),
      lineup: splitDashboardLine(prediction.lineupLine),
      modelReference: prediction.modelReferenceLines || splitDashboardLine(prediction.modelReferenceLine),
      news: prediction.newsContext || null,
    },
    reasons: prediction.agentAnalysis?.reasons || prediction.reasons || [],
    risk: prediction.agentAnalysis?.risk || '',
    memoryNote: prediction.agentAnalysis?.memoryNote || '',
  };
}

export async function livePredictions(dateYmd) {
  ensureInitialized();
  const predictions = await getMlbPredictions(dateYmd, storage.getMemory());

  // Mirror the bot's enrichment (see index.js buildAlertPayload): attach live
  // odds, then run the moneyline value engine so each prediction carries
  // betDecision / valuePick / kellyStakePercent. Odds may be unavailable (free
  // tier quota exhausted) — degrade gracefully so the dashboard still shows the
  // model's advisory confidence band instead of crashing or going blank.
  try {
    await attachCurrentOdds(predictions);
  } catch (error) {
    console.warn('Dashboard odds/value context unavailable:', error.message);
  }
  for (const prediction of predictions) {
    try {
      applyMoneylineValueMarket(prediction);
    } catch (error) {
      console.warn(`Value engine failed for game ${prediction.gamePk}:`, error.message);
    }
  }
  // Selection-only CLV gate — same policy as bot path; never mutates model probs.
  try {
    const gateConfig = config.clvGate || {};
    if (gateConfig.enabled !== false) {
      const rows = storage.readLedger({ includeArchived: true }) || [];
      const summary = summarizeClv(rows, {
        market: 'moneyline',
        lookback: gateConfig.lookback
      });
      for (const prediction of predictions) {
        applyClvGateToPrediction(prediction, summary, gateConfig);
      }
    }
  } catch (error) {
    console.warn('Dashboard CLV gate unavailable:', error.message);
  }
  try {
    await attachNewsContext(config, predictions, storage);
    persistNewsFeatureSnapshots(predictions, storage, dateYmd);
  } catch (error) {
    console.warn('Dashboard news context unavailable:', error.message);
  }

  const fetchedAt = new Date().toISOString();
  return {
    date: dateYmd,
    source: 'MLB StatsAPI live',
    updatedAt: fetchedAt,
    games: predictions.map((prediction) => summarizeLivePrediction(prediction, { dateYmd, fetchedAt })),
  };
}

function statusPayload() {
  ensureInitialized();
  const memory = storage.getMemorySummary();
  const state = storage.state;
  return {
    app: {
      name: packageJson.name,
      version: packageJson.version,
      dashboardPort: port,
      dashboardHost: host,
      serverDate: dateInTimezone(config.timezone),
      serverTime: new Date().toISOString(),
      cwd: process.cwd(),
    },
    config: {
      timezone: config.timezone,
      telegramConfigured: safeBoolean(config.telegramToken),
      telegramChatConfigured: safeBoolean(config.telegramChatId),
      openaiConfigured: safeBoolean(config.openai.apiKey),
      openaiModel: config.openai.model,
      analystAgentEnabled: config.analystAgent.enabled,
      analystAgentMode: config.analystAgent.mode,
      newsEnabled: config.news.enabled,
      autoAlerts: config.autoAlerts,
      dailyAlertTime: config.dailyAlertTime,
      postGameAlerts: config.postGameAlerts,
      modelMemory: config.modelMemory,
      pythonExecutable: config.pythonExecutable,
    },
    state: {
      subscriberCount: Object.keys(state.subscribers || {}).length,
      savedPredictionCount: Object.keys(state.predictions || {}).length,
      pendingPredictionDates: storage.listPendingPredictionDates(),
      lastAutoAlertDate: state.lastAutoAlertDate || '',
    },
    memory,
  };
}

async function routeApi(request, response, url) {
  ensureInitialized();
  if (!isAuthorized(request)) {
    sendError(response, 401, 'Unauthorized', 'Set Authorization: Bearer <DASHBOARD_API_TOKEN>');
    return true;
  }
  try {
    if (url.pathname === '/api/status') {
      sendJson(response, 200, statusPayload());
      return true;
    }

    if (url.pathname === '/api/sample/games') {
      sendJson(response, 200, await sampleGames());
      return true;
    }

    if (url.pathname === '/api/sample/analysis') {
      const gameId = url.searchParams.get('id') || '0';
      sendJson(response, 200, await sampleAnalysis(gameId));
      return true;
    }

    if (url.pathname === '/api/live/predictions') {
      const dateYmd = url.searchParams.get('date') || dateInTimezone(config.timezone);
      sendJson(response, 200, await livePredictions(dateYmd));
      return true;
    }

    if (url.pathname === '/api/evaluation') {
      sendJson(response, 200, await evaluationReport());
      return true;
    }

    if (url.pathname === '/api/backtest' && request.method === 'POST') {
      sendJson(response, 200, await runBacktest(await parseBody(request)));
      return true;
    }

    if (url.pathname === '/api/knowledge') {
      const question = url.searchParams.get('q') || 'Why does FIP matter more than ERA for pitcher prediction?';
      sendJson(response, 200, await knowledgeAnswer(question));
      return true;
    }
  } catch (error) {
    sendError(response, 500, 'Dashboard API failed', error.message);
    return true;
  }

  return false;
}

function serveStatic(request, response, url) {
  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = resolve(join(rootDir, relativePath));

  // Use a path separator to prevent prefix bypass (e.g. /dashboard-evil/...
  // would otherwise satisfy startsWith(rootDir) without the trailing sep).
  if (!filePath.startsWith(rootDir + sep) && filePath !== rootDir) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  if (!existsSync(filePath)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const extension = extname(filePath);
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
  });
  createReadStream(filePath).pipe(response);
}

function createDashboardServer() {
  return createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      const handled = await routeApi(request, response, url);
      if (!handled) sendError(response, 404, 'Unknown API route');
      return;
    }

    serveStatic(request, response, url);
  });
}

export function startDashboard({ enabled } = {}) {
  ensureInitialized();
  const isEnabled = enabled !== undefined ? enabled : config.dashboard?.enabled !== false;
  if (!isEnabled) {
    console.log('MLB dashboard disabled. Set DASHBOARD_ENABLED=true to enable it.');
    return Promise.resolve(null);
  }

  if (activeServer) return Promise.resolve(activeServer);

  // The dashboard API has no auth unless DASHBOARD_API_TOKEN is set, and
  // /api/backtest spawns Python. Refuse to expose it on a non-loopback host
  // without a token — fall back to loopback so the bot keeps running locally.
  if (!isLoopbackHost(host) && !dashboardApiToken()) {
    console.warn(
      `MLB dashboard: refusing to bind ${host} without DASHBOARD_API_TOKEN; using 127.0.0.1. Set a token to expose it.`
    );
    host = '127.0.0.1';
  }

  activeServer = createDashboardServer();
  return new Promise((resolveStart, rejectStart) => {
    activeServer.once('error', (error) => {
      activeServer = null;
      rejectStart(error);
    });
    activeServer.listen(port, host, () => {
      const entry = fileURLToPath(import.meta.url);
      console.log(`MLB dashboard running at http://localhost:${port}`);
      console.log(`MLB dashboard network bind: http://${host}:${port}`);
      console.log(`Dashboard server: ${entry}`);
      resolveStart(activeServer);
    });
  });
}

export function stopDashboard() {
  if (!activeServer) return Promise.resolve();
  return new Promise((resolveStop, rejectStop) => {
    activeServer.close((error) => {
      if (error) {
        rejectStop(error);
        return;
      }
      activeServer = null;
      resolveStop();
    });
  });
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  startDashboard().catch((error) => {
    console.error(`Dashboard failed: ${error.message}`);
    process.exitCode = 1;
  });
}
