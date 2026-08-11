import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { ANALYST_SKILL_VERSION, buildAnalystSkillSummary } from './analystSkill.js';
import { calibratePercent, hasCalibrationMap, resetCalibrationCache } from './calibration.js';
import { buildEvolutionContext } from './evolutionContext.js';
import { loadEvolutionControls, moneylineWeightMultiplier } from './evolutionControls.js';
import {
  analyzePredictionsWithAgent,
  answerInteractiveQuestion
} from './llm.js';
import {
  applyMoneylineValueMarket,
  detectSharpMoneySignal,
  formatPredictions,
  getFinalGameResults,
  getMlbPredictions,
  getMlbScheduleChoices,
  moneylineDecisionLines
} from './mlb.js';
import { Storage } from './storage.js';
import { resolveClvSide as resolveClvSideCore } from './clv_side.js';
import { applyClvGateToPrediction, summarizeClv } from './clv_gate.js';
import { attachNewsContext, persistNewsFeatureSnapshots } from './news.js';
import { setupWebhook, TelegramBot } from './telegram.js';
import { UI_LINE, UI_THIN_LINE, uiBullet, uiCommand, uiKV, uiSection, uiTitle } from './telegramFormat.js';
import { dateInTimezone, isValidDateYmd, percent, timeInTimezone, weekdayInTimezone } from './utils.js';
import { startDashboard } from './dashboard.js';
import { formatLedgerReport } from './ledgerReport.js';
import { formatShadowLedgerReport } from './shadowLedgerReport.js';
import {
  attachCurrentOdds,
  americanImpliedProbability,
  captureClosingLines,
  checkLineMovement,
  configureLineMonitor,
  lineMonitorSettings,
  resolveClosingLine,
  startLineMonitor,
  stopLineMonitorForChat
} from './lineMovement.js';
import {
  appendTeamLineup,
  configureLineupMonitor,
  lineupMonitorSettings,
  startLineupMonitor,
  stopLineupMonitorForChat
} from './lineupMonitor.js';

const config = loadConfig();
const storage = new Storage();
let postGameCheckRunning = false;
let autoUpdateCheckRunning = false;
let lineupAutoStartRunning = false;
let lastLineupAutoStartAt = 0;
const predictionCache = new Map();
const PREDICT_CALLBACK_PREFIX = 'predict_live:';
const LEGACY_PREDICT_CALLBACK_PREFIX = 'predict:';
// Legacy inline buttons from older /evolve messages still carry this prefix.
const EVOLVE_CALLBACK_PREFIX = 'evolve:';
const AUDIT_COMMAND = {
  module: 'src.evolution.evolution_audit',
  args: ['--summary', '--apply-safe', '--update-memory'],
  label: 'Evolution audit + learning memory'
};

function helpText() {
  return [
    uiTitle('⚾', 'MLB Bot | command utama'),
    '',
    uiSection('📋', 'Shortcut analyst'),
    uiCommand('/picks', 'top 5 pick model hari ini'),
    uiCommand('/picks YYYY-MM-DD', 'top pick untuk tanggal tertentu'),
    uiCommand('/predict', 'prediksi semua game MLB hari ini'),
    uiCommand('/predict YYYY-MM-DD', 'prediksi semua game pada tanggal tertentu'),
    uiCommand('/ledger', 'rekap bet nyata: open, record, units P/L, ROI'),
    uiCommand('/shadow', 'paper ledger kandidat VALUE yang diblokir CLV gate'),
    uiCommand('/analyze', 'analisa edge, risk, value, dan no-bet slate hari ini'),
    uiCommand('/analyze TEAM', 'analisa tim/game tertentu dari data bot'),
    uiCommand('/news', 'ringkas external MLB/ESPN/Yahoo context plus risk data bot'),
    '',
    uiSection('📊', 'Data & kontrol'),
    uiCommand('/today', 'list ringkas semua game hari ini'),
    uiCommand('/deep', 'semua game dengan statistik lengkap'),
    uiCommand('/game TEAM', 'cek tim tertentu hari ini'),
    uiCommand('/ask pertanyaan', 'tanya Analyst Agent bebas'),
    uiCommand('/evolve', 'belajar dari semua hasil final + tingkatkan edge (1 command, full otomatis)'),
    uiCommand('/linealerts on|off|status', 'atur notifikasi line movement'),
    '',
    uiBullet('💬', 'Pertanyaan biasa tanpa slash tetap masuk ke Analyst Agent.'),
    uiBullet('🧰', 'Command lama tetap hidden/backward-compatible, tapi tidak ditampilkan agar menu bersih.')
  ].join('\n');
}

function botCommandList() {
  return [
    { command: 'today', description: 'List ringkas semua game' },
    { command: 'deep', description: 'Semua game dengan statistik lengkap' },
    { command: 'picks', description: 'Top model picks' },
    { command: 'predict', description: 'Prediksi semua game MLB' },
    { command: 'ledger', description: 'Rekap bet nyata' },
    { command: 'shadow', description: 'Paper ledger CLV-blocked' },
    { command: 'analyze', description: 'Analisa slate atau tim' },
    { command: 'news', description: 'External news + risk context' },
    { command: 'game', description: 'Cek tim tertentu hari ini' },
    { command: 'ask', description: 'Tanya Analyst Agent' },
    { command: 'evolve', description: 'Belajar dari hasil final + tingkatkan edge' },
    { command: 'linealerts', description: 'Atur line movement alerts' }
  ];
}

function parseDateArg(args) {
  const first = args[0];
  if (!isValidDateYmd(first)) {
    return { dateYmd: dateInTimezone(config.timezone), rest: args };
  }
  return { dateYmd: first, rest: args.slice(1) };
}

function buildPicksQuestion(args) {
  const { dateYmd } = parseDateArg(args);
  return { dateYmd, question: 'best 5 top pick for today' };
}

function buildAnalyzeQuestion(args) {
  const text = args.join(' ').trim();
  return text
    ? `Analisa ${text}. Fokus pada edge model, risiko utama, market value, dan no-bet warning dari data yang tersedia.`
    : 'Analisa slate MLB hari ini. Fokus pada edge terkuat, risiko terbesar, market value, dan game yang sebaiknya no bet.';
}

function buildNewsQuestion(args) {
  const { dateYmd, rest } = parseDateArg(args);
  const target = rest.join(' ').trim();
  const scope = target ? `untuk ${target}` : 'untuk slate MLB hari ini';
  return {
    dateYmd,
    question: `Ringkas risk/news context ${scope} dari external news yang disediakan MLB/ESPN/Yahoo dan data bot. Pisahkan fakta terlapor dari opini, sebutkan source dan waktu publikasi, lalu gabungkan lineup, injury, probable pitcher, weather/park, market movement, dan data-quality warning. Jangan mengarang headline, expert opinion, atau berita live yang tidak ada di data. Probabilitas, pick, edge, status, dan stake tetap milik model deterministik.`
  };
}

function persistNewsFeatures(dateYmd, predictions) {
  try {
    persistNewsFeatureSnapshots(predictions, storage, dateYmd);
  } catch (error) {
    console.warn('News feature snapshot failed:', error.message);
  }
}

function isAllowed(chatId) {
  // Fail closed: an empty allowlist denies everyone rather than opening the bot
  // to any stranger who finds it (who could then burn paid LLM/Odds-API calls).
  // /chatid runs before this gate so a new operator can still discover their ID.
  if (config.allowedChatIds.length === 0) return false;
  return config.allowedChatIds.includes(String(chatId));
}

function applyNewsRiskVeto(predictions) {
  // News may only veto VALUE → NO BET. Never changes model probability or edge.
  for (const prediction of predictions || []) {
    const risk = prediction?.newsContext?.newsRisk;
    if (!risk?.veto || !Array.isArray(risk.vetoReasons) || risk.vetoReasons.length === 0) continue;
    // Re-run value market with existing odds, then force NO BET if still VALUE.
    applyMoneylineValueMarket(prediction);
    const decision = prediction.betDecision;
    if (!decision) continue;
    const extra = risk.vetoReasons;
    const reasons = [...new Set([...(decision.reasons || []), ...extra])];
    if (decision.status === 'VALUE' || decision.status === 'LEAN ONLY') {
      prediction.betDecision = {
        ...decision,
        status: 'NO BET',
        reason: reasons[0] || extra[0],
        reasons,
        newsVeto: true
      };
    } else if (decision.status === 'NO BET') {
      prediction.betDecision = {
        ...decision,
        reasons,
        newsVeto: true
      };
    }
  }
  return predictions;
}

/** Selection-only CLV gate after value engine. Never mutates model probs/edge math. */
function applyRollingClvGate(predictions) {
  const gateConfig = config.clvGate || {};
  if (gateConfig.enabled === false) return predictions;
  let rows = [];
  try {
    rows = storage.readLedger({ includeArchived: true }) || [];
  } catch {
    rows = [];
  }
  const summary = summarizeClv(rows, {
    market: 'moneyline',
    lookback: gateConfig.lookback
  });
  for (const prediction of predictions || []) {
    applyClvGateToPrediction(prediction, summary, gateConfig);
  }
  return predictions;
}

async function buildAlertPayload(dateYmd, options = {}) {
  const modelMemory = config.modelMemory ? storage.getMemory() : {};
  const predictions = await getMlbPredictions(dateYmd, modelMemory);
  const includeAdvanced = options.includeAdvanced ?? config.alertDetail === 'full';

  await attachOddsContext(predictions);
  await attachMarketContext(predictions);
  await attachNewsContext(config, predictions, storage);
  applyNewsRiskVeto(predictions);
  applyRollingClvGate(predictions);
  await attachAgentAnalyses(predictions);
  persistNewsFeatures(dateYmd, predictions);
  storage.savePredictions(dateYmd, predictions);

  return {
    text: formatPredictions(dateYmd, predictions, {
      maxGames: options.maxGames ?? (includeAdvanced ? config.maxGamesPerMessage : predictions.length),
      teamFilter: options.teamFilter || '',
      includeAdvanced,
      includeNews: config.news.includeAlerts
    }),
    predictions
  };
}

function dateForPrediction(prediction) {
  if (prediction?.dateYmd && isValidDateYmd(prediction.dateYmd)) return prediction.dateYmd;
  if (prediction?.startTime) {
    const parsed = new Date(prediction.startTime);
    if (!Number.isNaN(parsed.getTime())) return dateInTimezone(config.timezone, parsed);
  }
  return dateInTimezone(config.timezone);
}

async function sendBothLineupsPregameAlert(bot, chatId, game, awayLineup, homeLineup) {
  const dateYmd = dateForPrediction(game);
  const gamePk = String(game?.gamePk || game?.game_id || game?.id || '');
  if (!gamePk) return false;

  const modelMemory = config.modelMemory ? storage.getMemory() : {};
  const predictions = await getMlbPredictions(dateYmd, modelMemory);
  await attachOddsContext(predictions);
  await attachMarketContext(predictions);
  await attachNewsContext(config, predictions, storage);
  applyNewsRiskVeto(predictions);
  applyRollingClvGate(predictions);
  await attachAgentAnalyses(predictions);
  persistNewsFeatures(dateYmd, predictions);
  storage.savePredictions(dateYmd, predictions);

  const prediction = predictions.find((item) => String(item.gamePk || item.game_id || item.id || '') === gamePk);

  const awayLabel = prediction?.away?.abbreviation || prediction?.away?.name || game?.away?.abbreviation || game?.away?.name || 'Away';
  const homeLabel = prediction?.home?.abbreviation || prediction?.home?.name || game?.home?.abbreviation || game?.home?.name || 'Home';

  const lines = [
    uiTitle('📋', `Lineup Confirmed | ${awayLabel} @ ${homeLabel}`),
    uiBullet('✅', 'Kedua tim sudah announce lineup. Model re-run dengan lineup terbaru.'),
    ''
  ];

  if (awayLineup?.confirmed || homeLineup?.confirmed) {
    appendTeamLineup(lines, awayLabel, prediction?.away || game?.away, awayLineup);
    appendTeamLineup(lines, homeLabel, prediction?.home || game?.home, homeLineup);
  }

  if (prediction) {
    const pick = prediction.winner;
    const pickName = pick?.name || pick?.abbreviation || 'TBD';
    const homeProb = Number(prediction.home?.winProbability ?? 0);
    const awayProb = Number(prediction.away?.winProbability ?? 0);
    const pickProb = pick && pick === prediction.home ? homeProb : awayProb;
    const confirmationEdge = Number(prediction.modelBreakdown?.confirmationEdge ?? 0);
    const bothConfirmed = awayLineup?.confirmed && homeLineup?.confirmed;

    lines.push(uiSection('🎯', 'Pick Model (lineup confirmed)'));
    lines.push(uiKV('✅', 'Pick', `${pickName} ${pickProb.toFixed(1)}%`));
    lines.push(uiKV('📊', 'Probabilitas', `${awayLabel} ${awayProb.toFixed(1)}% | ${homeLabel} ${homeProb.toFixed(1)}%`));
    if (bothConfirmed && Math.abs(confirmationEdge) >= 0.005) {
      const edgeLabel = confirmationEdge > 0 ? homeLabel : awayLabel;
      lines.push(uiKV('📋', 'Lineup edge', `+${(Math.abs(confirmationEdge) * 100).toFixed(1)}% ke ${edgeLabel} (lineup confirmed menguatkan edge model)`));
    } else if (bothConfirmed) {
      lines.push(uiKV('📋', 'Lineup edge', 'netral (matchup terlalu tipis untuk dikuatkan)'));
    }
    lines.push('');

    lines.push(formatPredictions(dateYmd, [prediction], { maxGames: 1, includeAdvanced: false }));
  }

  await bot.sendMessage(chatId, lines.join('\n'));
  return true;
}

async function attachOddsContext(predictions) {
  await attachCurrentOdds(predictions).catch((error) => {
    console.warn('Odds/value engine context unavailable:', error.message);
    return null;
  });
}

function currentOddsNeedsRefresh(prediction, now = Date.now()) {
  const odds = prediction?.currentOdds;
  if (!odds?.awayMoneyline || !odds?.homeMoneyline) return true;
  const fetchedAt = Date.parse(odds.oddsFetchedAt || odds.fetchedAt || odds.updatedAt || '');
  if (!Number.isFinite(fetchedAt)) return true;
  const maxAgeMinutes = Number(config.moneylineOddsMaxAgeMinutes);
  const maxAgeMs = (Number.isFinite(maxAgeMinutes) && maxAgeMinutes > 0 ? maxAgeMinutes : 10) * 60_000;
  return now - fetchedAt > maxAgeMs;
}

async function attachMarketContext(predictions) {
  if (predictions.some((prediction) => currentOddsNeedsRefresh(prediction))) {
    await attachOddsContext(predictions);
  }

  const evolutionControls = loadEvolutionControls();
  const marketOddsMultiplier = moneylineWeightMultiplier(evolutionControls, 'market_odds');

  for (const prediction of predictions) {
    const currentOddsFresh = !currentOddsNeedsRefresh(prediction);
    const pureHome = Number(prediction.home?.pureModelProbability ?? prediction.modelBreakdown?.pureHomeProbability ?? prediction.home?.winProbability);
    const pureAway = Number(prediction.away?.pureModelProbability ?? prediction.modelBreakdown?.pureAwayProbability ?? prediction.away?.winProbability);
    if (Number.isFinite(pureHome)) prediction.home.pureModelProbability = pureHome;
    if (Number.isFinite(pureAway)) prediction.away.pureModelProbability = pureAway;
    if (prediction.modelBreakdown) {
      if (Number.isFinite(pureHome)) prediction.modelBreakdown.pureHomeProbability = pureHome;
      if (Number.isFinite(pureAway)) prediction.modelBreakdown.pureAwayProbability = pureAway;
    }
    if (Number.isFinite(pureHome)) prediction.home.winProbability = pureHome;
    if (Number.isFinite(pureAway)) prediction.away.winProbability = pureAway;
    if (Number.isFinite(pureHome) && Number.isFinite(pureAway)) {
      prediction.winner = pureHome >= pureAway ? prediction.home : prediction.away;
    }
    prediction.home.marketInformedProbability = null;
    prediction.away.marketInformedProbability = null;
    if (prediction.modelBreakdown) {
      prediction.modelBreakdown.marketBlendedHomeProbability = null;
      prediction.modelBreakdown.marketBlendedAwayProbability = null;
      prediction.modelBreakdown.marketInformedHomeProbability = null;
      prediction.modelBreakdown.marketInformedAwayProbability = null;
    }

    // Bayesian prior: blend model probability with market-implied probability.
    // Market odds are the single best predictor; even a small blend (10-15%)
    // improves calibration and reduces overconfidence.
    if (currentOddsFresh && prediction.currentOdds && marketOddsMultiplier > 0) {
      const homeImplied = americanImpliedProbability(prediction.currentOdds.homeMoneyline);
      const awayImplied = americanImpliedProbability(prediction.currentOdds.awayMoneyline);
      if (homeImplied != null && awayImplied != null) {
        // Normalize implied to sum to 100 (removes the vig)
        const totalImplied = homeImplied + awayImplied;
        const homeNorm = (homeImplied / totalImplied) * 100;
        const awayNorm = (awayImplied / totalImplied) * 100;
        // Blend weight: market is the strongest single pre-game predictor.
        // Raised base from 0.12 → 0.22 so displayed pick incorporates real odds
        // without fully overwriting pure-model VALUE grading.
        const w = Math.min(0.35, 0.22 * marketOddsMultiplier);
        const rawHome = Number(prediction.modelBreakdown?.rawHomeProbability ?? prediction.home?.winProbabilityRaw ?? prediction.home?.winProbability);
        const rawAway = Number(prediction.modelBreakdown?.rawAwayProbability ?? prediction.away?.winProbabilityRaw ?? prediction.away?.winProbability);
        if (Number.isFinite(rawHome) && Number.isFinite(rawAway)) {
          const blendedHome = rawHome * (1 - w) + homeNorm * w;
          const blendedAway = rawAway * (1 - w) + awayNorm * w;
          // Re-calibrate the blended probabilities. Keep winProbabilityRaw anchored
          // to the original model so repeated /picks calls do not compound-blend.
          const calibrated = hasCalibrationMap('moneyline');
          const newHome = calibrated
            ? Math.round(Math.max(30, Math.min(70, calibratePercent(blendedHome, 'moneyline'))))
            : Math.round(Math.max(30, Math.min(70, blendedHome)));
          const newAway = 100 - newHome;
          prediction.home.marketInformedProbability = newHome;
          prediction.away.marketInformedProbability = newAway;
          prediction.home.winProbability = newHome;
          prediction.away.winProbability = newAway;
          if (prediction.modelBreakdown) {
            prediction.modelBreakdown.marketBlendedHomeProbability = blendedHome;
            prediction.modelBreakdown.marketBlendedAwayProbability = blendedAway;
            prediction.modelBreakdown.marketInformedHomeProbability = newHome;
            prediction.modelBreakdown.marketInformedAwayProbability = newAway;
          }
          // Update winner based on new probabilities
          if (newHome >= newAway) {
            prediction.winner = prediction.home;
          } else {
            prediction.winner = prediction.away;
          }
        }
      }
    }

    // Sharp money detection: compare opening odds vs current odds
    // Now that fresh odds are attached, we can detect line movement before VALUE gating.
    const openingOdds = prediction.openingOdds || storage.openingOddsFromSnapshots(prediction.gamePk);
    const currentOdds = currentOddsFresh ? prediction.currentOdds : null;
    if (openingOdds && currentOdds && prediction.modelBreakdown) {
      const pickName = prediction.winner?.name ||
        (prediction.home?.winProbability >= prediction.away?.winProbability ? prediction.home?.name : prediction.away?.name);
      if (pickName) {
        // Convert to the format detectSharpMoneySignal expects: { teamName: odds }
        const opening = {};
        const closing = {};
        if (openingOdds.homeMoneyline != null) {
          const homeName = prediction.home?.name;
          if (homeName) opening[homeName] = openingOdds.homeMoneyline;
        }
        if (openingOdds.awayMoneyline != null) {
          const awayName = prediction.away?.name;
          if (awayName) opening[awayName] = openingOdds.awayMoneyline;
        }
        if (currentOdds.homeMoneyline != null) {
          const homeName = prediction.home?.name;
          if (homeName) closing[homeName] = currentOdds.homeMoneyline;
        }
        if (currentOdds.awayMoneyline != null) {
          const awayName = prediction.away?.name;
          if (awayName) closing[awayName] = currentOdds.awayMoneyline;
        }
        if (Object.keys(opening).length > 0 && Object.keys(closing).length > 0) {
          prediction.modelBreakdown.sharpMoney = detectSharpMoneySignal(pickName, opening, closing);
        }
      }
    }

    applyMoneylineValueMarket(prediction);
  }

  return predictions;
}

async function buildAlert(dateYmd, options = {}) {
  const payload = await buildAlertPayload(dateYmd, options);
  return payload.text;
}

async function attachAgentAnalyses(predictions) {
  const evolutionData = buildEvolutionContext();
  const analyses = await analyzePredictionsWithAgent(
    config,
    predictions,
    storage.getMemorySummary(),
    evolutionData
  ).catch((error) => {
    console.error('Analyst Agent error:', error.message);
    return [];
  });

  console.log('[analyst] active %d/%d games', analyses.length, predictions.length);
  if (analyses.length === 0 && predictions.length > 0) {
    console.warn('[analyst] NO analyses — all picks fall back to baseline (confidence=model). Check [analyst] logs above for the reason (HTTP status / empty key / parse).');
  }

  const analysesByGame = new Map(analyses.map((analysis) => [analysis.gamePk, analysis]));
  for (const prediction of predictions) {
    const analysis = analysesByGame.get(prediction.gamePk) || null;
    prediction.agentAnalysis = analysis;
  }

  return predictions;
}

function targetChatIds() {
  const chatIds = new Set(storage.listSubscriberIds());
  if (config.telegramChatId) chatIds.add(String(config.telegramChatId));
  return [...chatIds];
}

function isValidTime(value) {
  if (!/^\d{2}:\d{2}$/.test(String(value || ''))) return false;
  const [hour, minute] = String(value).split(':').map((item) => Number.parseInt(item, 10));
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function targetAutoUpdateChats() {
  const targets = new Map();
  for (const target of storage.listAutoUpdateTargets(config.dailyAlertTime)) {
    targets.set(String(target.chatId), target);
  }

  if (config.autoAlerts) {
    for (const chatId of targetChatIds()) {
      if (!targets.has(String(chatId))) {
        targets.set(String(chatId), {
          chatId: String(chatId),
          title: String(chatId),
          dailyTime: config.dailyAlertTime,
          lastSentDate: storage.getLastAutoAlertDate(),
          legacyEnv: true
        });
      }
    }
  }

  return [...targets.values()];
}

async function sendTextToAll(bot, text) {
  const chatIds = targetChatIds();
  for (const chatId of chatIds) {
    await bot.sendMessage(chatId, text).catch((error) => {
      console.error(`Gagal kirim ke ${chatId}:`, error.message);
    });
  }

  return chatIds.length;
}

function maybeStartLineMonitor(predictions, chatId, dateYmd) {
  if (dateYmd !== dateInTimezone(config.timezone)) return;
  startLineMonitor(predictions, chatId);
  startLineupMonitor(predictions, chatId);
}

async function sendAlert(bot, chatId, dateYmd, options = {}) {
  const { text, predictions } = await buildAlertPayload(dateYmd, options);
  await bot.sendMessage(chatId, text);
  maybeStartLineMonitor(predictions, chatId, dateYmd);
  console.log(`Alert ${dateYmd} sent to ${chatId}.`);
}

function predictionHelpText() {
  return [
    uiTitle('📊', 'MLB Prediction | help'),
    '',
     uiKV('🧭', 'Mode', '/predict mengirim semua game langsung'),
     uiKV('⌨️', 'Tanggal', '/predict YYYY-MM-DD'),
    '',
    uiSection('💡', 'Contoh'),
     '',
     uiBullet('⚠️', 'Untuk ringkasan singkat gunakan /today; /predict menampilkan detail seluruh slate.')
  ].join('\n');
}

function predictionKeyboard(dateYmd, games) {
  return {
    inline_keyboard: games.map((game) => [
      {
        text: `${game.away.abbreviation || game.away.name} @ ${game.home.abbreviation || game.home.name} - ${game.start}`,
        callback_data: `${PREDICT_CALLBACK_PREFIX}${dateYmd}:${game.gamePk}`
      }
    ])
  };
}

async function sendPredictionGameMenu(bot, chatId, dateYmd = '') {
  const targetDate = dateYmd || dateInTimezone(config.timezone);
  const games = await getMlbScheduleChoices(targetDate);

  if (games.length === 0) {
    await bot.sendMessage(
      chatId,
      [
        uiTitle('📊', 'MLB Prediction | game list'),
        uiKV('📅', 'Tanggal', targetDate),
        '',
        uiBullet('⚠️', 'Tidak ada game MLB pada tanggal ini.'),
        uiCommand('/predict Los Angeles Dodgers | New York Yankees', 'pakai format manual')
      ].join('\n')
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    [
      uiTitle('📊', 'Pilih Game | MLB prediction'),
      uiKV('📅', 'Tanggal', targetDate),
      uiKV('📡', 'Sumber', `MLB StatsAPI live schedule | ${games.length} game`),
      '',
      uiBullet('👇', 'Tap salah satu matchup di bawah.')
    ].join('\n'),
    {
      reply_markup: predictionKeyboard(targetDate, games)
    }
  );
}

function parsePredictCommand(text) {
  const payload = text.replace(/^\/predict(?:@\S+)?\s*/i, '').trim();
  if (!payload) return { menu: true };
  if (isValidDateYmd(payload)) return { menu: true, dateYmd: payload };
  return { menu: true };
}

function runAgentBridge(action, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonExecutable, ['-m', 'src.telegram_agent_bridge', action, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1'
      },
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Agent tools timeout. Coba lagi sebentar.'));
    }, 20_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || `Python exited with code ${code}`).trim()));
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim() || '{}'));
      } catch (error) {
        reject(new Error(`Agent tools output tidak valid: ${error.message}`));
      }
    });
  });
}

function fetchKnowledgeContext(question) {
  return new Promise((resolve) => {
    const child = spawn(config.pythonExecutable, [
      '-c',
      'import json, sys; from src.knowledge.baseball_knowledge import BaseballKnowledgeBase; kb = BaseballKnowledgeBase(); print(json.dumps(kb.search(sys.argv[1], limit=3), default=str))',
      question
    ], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      windowsHide: true
    });

    let stdout = '';
    const timer = setTimeout(() => { child.kill(); resolve(''); }, 8000);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve(''); return; }
      try {
        const chunks = JSON.parse(stdout.trim() || '[]');
        const text = chunks
          .map((c) => `[${c.heading || c.source || 'MLB'}] ${c.text || c.content || ''}`.slice(0, 500))
          .join('\n\n');
        resolve(text);
      } catch {
        resolve('');
      }
    });
  });
}

function runPythonModule(moduleName, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonExecutable, ['-m', moduleName, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1'
      },
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(options.timeoutMessage || 'Evolution command timeout. Coba lagi sebentar.'));
    }, options.timeoutMs || 60_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || `Python exited with code ${code}`).trim()));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

function parseJsonOutput(output) {
  const text = String(output || '').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function numberValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return 0;
}

function phaseDiagnostic(label, phase) {
  if (!phase || typeof phase !== 'object') return null;
  if (phase.error) return uiKV('🚨', label, String(phase.error));
  if (phase.raw) return uiKV('⚠️', label, `output Python tidak bisa diparse JSON (${String(phase.raw).slice(0, 120)})`);
  return null;
}

function formatEvolveResult(payload) {
  const postgame = payload.postgame || {};
  const cycle = payload.cycle || {};
  const backfill = cycle.backfill || {};
  const ingest = cycle.ingest || {};
  const summary = cycle.summary || {};
  const calibration = cycle.calibration || {};
  const audit = payload.audit || {};
  const auditSummary = audit.summary || {};
  const applied = audit.applied_updates || {};
  const diagnostics = [
    phaseDiagnostic('Cycle', cycle),
    phaseDiagnostic('Audit', audit)
  ].filter(Boolean);
  const calibratedMarkets = Array.isArray(calibration.calibrated_markets)
    ? calibration.calibrated_markets
    : [];

  const newSymbolic = numberValue(cycle.symbolic_candidates);
  const totalSymbolic = numberValue(cycle.total_symbolic_candidates);
  const newRules = numberValue(cycle.rule_candidates);
  const totalRules = numberValue(cycle.total_rule_candidates);
  const ingestedNew = numberValue(ingest.evaluated);
  const skippedDup = numberValue(ingest.skipped_duplicates);
  const totalEvaluated = numberValue(summary.total_predictions_evaluated, auditSummary.evaluated);
  const totalLessons = numberValue(summary.lessons_generated, auditSummary.lessons);
  const totalLosses = numberValue(summary.language_losses_generated, auditSummary.language_losses);
  const totalGradients = numberValue(summary.language_gradients_generated, auditSummary.language_gradients);
  const totalCandidates = numberValue(summary.candidates_proposed, auditSummary.candidates);
  const dataDir = cycle.evolution_data_dir || audit.evolution_data_dir;
  const noNewButHasHistory = Number(ingestedNew) === 0 && Number(totalEvaluated) > 0;
  const noSafeUpdate = (applied.rules_added || []).length === 0 &&
    (applied.rules_released || []).length === 0 &&
    (applied.weight_versions_added || []).length === 0;

  return [
    uiTitle('🧠', 'MLB Agent Evolution | selesai'),
    '',
    diagnostics.length ? uiSection('⚠️', 'Diagnostics') : null,
    ...diagnostics,
    diagnostics.length ? '' : null,
    uiSection('🏁', 'Post-game'),
    uiKV('📅', 'Tanggal dicek', postgame.dates_checked ?? 0),
    uiKV('🧠', 'Game baru dipelajari', postgame.learned_games ?? 0),
    '',
    uiSection('🩹', 'Backfill data flat'),
    uiKV('🔧', 'Baris diperbaiki', backfill.updated ?? 0),
    '',
    uiSection('📥', 'Ingest'),
    uiKV('📊', 'Evaluasi baru/run ini', ingestedNew),
    uiKV('♻️', 'Duplikat dilewati', skippedDup),
    noNewButHasHistory ? uiBullet('📚', `Tidak ada evaluasi baru; ${totalEvaluated} evaluasi historis tetap terbaca.`) : null,
    '',
    uiSection('🎚️', 'Kalibrasi'),
    uiKV('✅', 'Market terkalibrasi', calibratedMarkets.length ? calibratedMarkets.join(', ') : 'belum cukup sample'),
    '',
    uiSection('🔄', 'Cycle'),
    uiKV('🧪', 'Symbolic baru/tersimpan', `${newSymbolic}/${totalSymbolic}`),
    uiKV('📏', 'Rule queue baru/tersimpan', `${newRules}/${totalRules}`),
    '',
    uiSection('🔎', 'Audit'),
    uiKV('📊', 'Evaluated', auditSummary.evaluated ?? 0),
    uiKV('📈', 'Accuracy', `${auditSummary.accuracy ?? 0}%`),
    uiKV('🔧', 'Rules added', (applied.rules_added || []).length),
    uiKV('🔓', 'Rules released', (applied.rules_released || []).length),
    uiKV('🎛️', 'Active controls', applied.active_control_count ?? '—'),
    uiKV('⚖️', 'Weight updates', (applied.weight_versions_added || []).length),
    noSafeUpdate && applied.note ? uiBullet('ℹ️', applied.note) : null,
    '',
    uiSection('📌', 'Total tersimpan'),
    uiKV('📊', 'Evaluated', totalEvaluated),
    uiKV('📚', 'Lessons', totalLessons),
    uiKV('🧾', 'Losses/gradients', `${totalLosses}/${totalGradients}`),
    uiKV('🧪', 'Candidates unik', totalCandidates),
    dataDir ? uiKV('📁', 'Evolution data', dataDir) : null,
    '',
    uiBullet('🛡️', 'Guardrail aman diterapkan otomatis. Rules/prompt/weights production tetap lewat promotion gate.')
  ].filter((line) => line !== null && line !== undefined).join('\n');
}

async function processStoredPostGamesForEvolution() {
  const dates = storage.listPendingPredictionDates();
  const result = {
    dates_checked: 0,
    evaluated_games: 0,
    learned_games: 0,
    errors: []
  };

  for (const dateYmd of dates) {
    result.dates_checked += 1;
    try {
      const evaluations = await evaluatePostGames(dateYmd, {
        markProcessed: true,
        includeProcessed: false
      });
      result.evaluated_games += evaluations.length;
      result.learned_games += evaluations.filter((evaluation) => evaluation.learned).length;
    } catch (error) {
      result.errors.push(`${dateYmd}: ${error.message}`);
    }
  }

  return result;
}

async function handleEvolve(bot, chatId) {
  await bot.sendMessage(chatId, uiKV('⏳', 'Menjalankan', 'Evolution penuh — belajar + tingkatkan edge'));

  // 1. Settle any pending final games into the bot's learning log.
  const postgame = await processStoredPostGamesForEvolution();

  // 2. Full cycle: backfill flat history, ingest, rebuild calibration, propose candidates.
  const cycleOutput = await runPythonModule('src.evolution.evolution_engine', ['--run-cycle'], {
    timeoutMessage: 'Evolution cycle timeout. Coba lagi sebentar.',
    timeoutMs: 120_000
  }).catch((error) => JSON.stringify({ error: error.message }));
  const cycle = parseJsonOutput(cycleOutput);

  // 3. Audit: apply safe guardrails + refresh learning memory.
  const auditOutput = await runPythonModule(AUDIT_COMMAND.module, AUDIT_COMMAND.args, {
    timeoutMessage: 'Audit timeout. Coba lagi sebentar.',
    timeoutMs: 120_000
  }).catch((error) => JSON.stringify({ error: error.message }));
  const audit = parseJsonOutput(auditOutput);

  await bot.sendMessage(chatId, formatEvolveResult({ postgame, cycle, audit }));
}

async function sendKnowledgeAnswer(bot, chatId, query) {
  const payload = await runAgentBridge('knowledge', [query]);
  await bot.sendMessage(chatId, payload.text || uiBullet('⚠️', 'Knowledge tidak tersedia.'));
}

function displayedPredictionProbabilities(prediction) {
  return {
    away: Math.round(prediction.away.winProbability),
    home: Math.round(prediction.home.winProbability)
  };
}

function predictionPick(prediction) {
  return prediction.winner;
}

function lineupContextLines(lineupLine) {
  const lines = String(lineupLine || '')
    .split(' | ')
    .filter(Boolean);

  return lines.length ? lines.map((line) => uiBullet('•', line)) : [uiKV('•', 'Lineup', 'belum tersedia')];
}

function formatLivePrediction(dateYmd, prediction, options = {}) {
  const probabilities = displayedPredictionProbabilities(prediction);
  const pick = predictionPick(prediction);
  const agentActive = Boolean(prediction.agentAnalysis);
  const reasons = agentActive ? prediction.agentAnalysis.reasons : prediction.reasons;
  const pickConfidence = prediction.pickConfidence || prediction.valueConfidence;
  const confidence = agentActive
    ? prediction.agentAnalysis.confidence
    : pickConfidence?.level
      ? `${pickConfidence.level}${pickConfidence.summary ? ` — ${pickConfidence.summary}` : ''}`
      : 'model';
  const pickProbability =
    pick.id === prediction.away.id ? probabilities.away : probabilities.home;
  const opponent = pick.id === prediction.away.id ? prediction.home : prediction.away;
  const opponentProbability =
    pick.id === prediction.away.id ? probabilities.home : probabilities.away;
  const injuryLines = prediction.injuryDetailLines?.length
    ? prediction.injuryDetailLines.map((line) => `• ${line}`)
    : [`• ${prediction.injuryLine || 'Data injury tidak tersedia.'}`];
  const modelReferenceLines = prediction.modelReferenceLines?.length
    ? prediction.modelReferenceLines.map((line) => `• ${line}`)
    : [`• ${prediction.modelReferenceLine}`];
  const newsRisk = prediction.newsContext?.newsRisk;
  const newsRiskLines = newsRisk?.flags?.length
    ? [
        uiSection('📰', 'News Risk'),
        ...newsRisk.flags.slice(0, 4).map((f) => `• [${f.severity}] ${f.flag}: ${f.title || f.source || ''}`),
        newsRisk.veto ? uiKV('🛑', 'Veto', (newsRisk.vetoReasons || []).join(' | ')) : null,
        ''
      ]
    : prediction.newsContext?.status && prediction.newsContext.status !== 'disabled'
      ? [
          uiSection('📰', 'News'),
          uiBullet('•', `status ${prediction.newsContext.status} | articles ${prediction.newsContext.articles?.length || 0}`),
          ''
        ]
      : [];

  return [
    uiTitle('📊', 'MLB Prediction'),
    uiKV('📅', 'Tanggal', dateYmd),
    '',
    uiKV('🏟️', 'Matchup', `${prediction.away.name} @ ${prediction.home.name}`),
    uiKV('🕒', 'Waktu', prediction.start),
    uiKV('📍', 'Stadium', prediction.venue),
    '',
    UI_THIN_LINE,
    uiSection('🏆', 'Hasil Predict'),
    uiKV('✅', 'Predicted Winner', pick.name),
    uiKV('📈', 'Win Probability', percent(pickProbability)),
    uiKV('🥊', 'Opponent', `${opponent.name} | ${percent(opponentProbability)}`),
    uiKV('🎚️', 'Confidence', confidence),
    uiKV('📌', 'Status', prediction.betDecision?.status || 'n/a'),
    ...moneylineDecisionLines(prediction),
    uiKV('📡', 'Source', agentActive ? 'Analyst Agent + live MLB stats' : 'Baseline model + live MLB stats'),
    '',
    UI_THIN_LINE,
    uiSection('📊', 'Probabilitas Detail'),
    uiKV('📊', 'Model', `${prediction.away.abbreviation || prediction.away.name} ${percent(probabilities.away)} | ${prediction.home.abbreviation || prediction.home.name} ${percent(probabilities.home)}`),
    agentActive
      ? uiKV('📐', 'Baseline', `${prediction.away.abbreviation || prediction.away.name} ${percent(prediction.away.winProbability)} | ${prediction.home.abbreviation || prediction.home.name} ${percent(prediction.home.winProbability)}`)
      : null,
    '',
    UI_THIN_LINE,
    uiSection('🔥', 'Starting Pitcher'),
    `${prediction.away.starterLine} vs ${prediction.home.starterLine}`,
    '',
    uiSection('🏥', 'Injury Report'),
    ...injuryLines,
    '',
    ...newsRiskLines,
    uiSection('🧠', 'ML Reference'),
    ...modelReferenceLines,
    '',
    uiSection('💡', 'Alasan'),
    ...reasons.slice(0, 3).map((reason) => `• ${reason}`),
    agentActive ? uiKV('⚠️', 'Risk', prediction.agentAnalysis.risk) : null,
    '',
    uiBullet('⚠️', 'Estimasi model, bukan jaminan hasil atau betting advice.')
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n');
}

async function sendPythonPrediction(bot, chatId, text) {
  const request = parsePredictCommand(text);
  const dateYmd = request.dateYmd || dateInTimezone(config.timezone);
  await bot.sendMessage(
    chatId,
    uiKV('⏳', 'Menganalisa semua game MLB', dateYmd)
  );
  const { predictions } = await buildAlertPayload(dateYmd);
  if (predictions.length === 0) {
    await bot.sendMessage(chatId, uiBullet('⚠️', `Tidak ada game MLB pada ${dateYmd}.`));
    return;
  }

  const output = predictions
    .map((prediction) => formatLivePrediction(dateYmd, prediction))
    .join(`\n\n${UI_LINE}\n\n`);
  await bot.sendMessage(chatId, output);
  maybeStartLineMonitor(predictions, chatId, dateYmd);
  console.log(`All-game prediction ${dateYmd} sent to ${chatId}: ${predictions.length} game(s).`);
}

async function handlePredictCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const data = callbackQuery.data || '';
  const [dateYmd, rawGamePk] = data.slice(PREDICT_CALLBACK_PREFIX.length).split(':');
  const gamePk = Number.parseInt(rawGamePk, 10);

  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Mengambil prediksi...' }).catch(() => {});

  if (!chatId) return;
  if (!isValidDateYmd(dateYmd) || !Number.isFinite(gamePk)) {
    await bot.sendMessage(chatId, uiBullet('⚠️', 'Data tombol tidak valid. Coba kirim /predict lagi untuk refresh daftar.'));
    return;
  }

  await bot.sendMessage(chatId, uiKV('⏳', 'Menganalisa game MLB', dateYmd));
  const modelMemory = config.modelMemory ? storage.getMemory() : {};
  const predictions = await getMlbPredictions(dateYmd, modelMemory);
  const prediction = predictions.find((item) => item.gamePk === gamePk);

  if (!prediction) {
    await bot.sendMessage(chatId, uiBullet('⚠️', 'Game tidak ditemukan. Coba kirim /predict lagi untuk refresh daftar.'));
    return;
  }

  await attachOddsContext([prediction]);
  await attachMarketContext([prediction]);
  await attachNewsContext(config, [prediction], storage);
  applyNewsRiskVeto([prediction]);
  applyRollingClvGate([prediction]);
  await attachAgentAnalyses([prediction]);
  persistNewsFeatures(dateYmd, [prediction]);
  storage.savePredictions(dateYmd, [prediction]);
  await bot.sendMessage(chatId, formatLivePrediction(dateYmd, prediction));
  console.log(
    `Live prediction callback handled for ${chatId}: ${prediction.away.name} @ ${prediction.home.name}.`
  );
}

async function sendAlertToAll(bot, dateYmd) {
  const chatIds = targetChatIds();

  if (chatIds.length === 0) {
    return 0;
  }

  const { text, predictions } = await buildAlertPayload(dateYmd);
  for (const chatId of chatIds) {
    await bot
      .sendMessage(chatId, text)
      .then(() => {
        maybeStartLineMonitor(predictions, chatId, dateYmd);
      })
      .catch((error) => {
        console.error(`Gagal kirim ke ${chatId}:`, error.message);
      });
  }

  return chatIds.length;
}

function formatLineCheckMovement(movement) {
  const market = `Moneyline ${movement.teamLabel || ''}`.trim();
  const delta = `${movement.delta >= 0 ? '+' : ''}${Math.round(movement.delta)}`;

  return uiBullet('•', `${movement.matchup} | ${market} | ${movement.oldText} -> ${movement.newText} | ${delta} ${movement.unit}`);
}

function formatLineCheckSummary(dateYmd, result, { source = 'stored predictions' } = {}) {
  const settings = lineMonitorSettings();

  if (!result.hasOddsApiKey) {
    return [
      uiTitle('📊', 'Linecheck MLB'),
      uiKV('📅', 'Tanggal', dateYmd),
      '',
      uiBullet('⚠️', 'ODDS_API_KEY/THE_ODDS_API_KEY belum diisi, jadi odds live belum bisa dicek.')
    ].join('\n');
  }

  if (result.checkedGames === 0) {
    return [uiTitle('📊', 'Linecheck MLB'), uiKV('📅', 'Tanggal', dateYmd), '', uiBullet('⚠️', 'Tidak ada game aktif untuk dicek.')].join(
      '\n'
    );
  }

  const movementLines = result.movements.slice(0, 6).map(formatLineCheckMovement);
  const hiddenMovements = Math.max(0, result.movements.length - movementLines.length);

  return [
    uiTitle('📊', 'Linecheck MLB'),
    uiKV('📅', 'Tanggal', dateYmd),
    uiKV('📡', 'Sumber game', source),
    uiKV('🎯', 'Matched odds', `${result.matchedGames}/${result.checkedGames}`),
    uiKV('📏', 'Threshold', `ML ${settings.moneylineThreshold} cents`),
    result.initializedSnapshots > 0
      ? uiKV('💾', 'Baseline odds tersimpan', `${result.initializedSnapshots} market`)
      : null,
    '',
    result.movements.length > 0
      ? uiKV('📈', 'Movement melewati threshold', `${result.movements.length} | ${result.alertsSent} alert terkirim`)
      : uiBullet('✅', 'Belum ada movement yang melewati threshold.'),
    ...movementLines,
    hiddenMovements > 0 ? uiBullet('➕', `${hiddenMovements} movement lain.`) : null
  ]
    .filter(Boolean)
    .join('\n');
}

async function loadLineCheckGames(dateYmd) {
  const storedPredictions = storage.listPredictionsByDate(dateYmd);
  if (storedPredictions.length > 0) {
    return { games: storedPredictions, source: 'stored pre-game alert' };
  }

  const scheduleGames = await getMlbScheduleChoices(dateYmd);
  return { games: scheduleGames, source: 'MLB live schedule' };
}

async function handleLineCheckCommand(bot, chatId) {
  const dateYmd = dateInTimezone(config.timezone);
  await bot.sendMessage(chatId, uiKV('⏳', 'Mengecek line movement MLB', dateYmd));
  const { games, source } = await loadLineCheckGames(dateYmd);
  const result = await checkLineMovement(games, chatId, { sendAlerts: true });
  await bot.sendMessage(chatId, formatLineCheckSummary(dateYmd, result, { source }));
}

function formatMemorySummary() {
  const summary = storage.getMemorySummary();
  const confidenceLines = Object.entries(summary.byConfidence || {})
    .map(([key, value]) => {
      const accuracy = value.total > 0 ? Math.round((value.correct / value.total) * 100) : 0;
      return uiKV('•', key, `${value.correct}/${value.total} | ${accuracy}%`);
    })
    .join('\n');
  const matchupMemory = summary.matchupMemory || { totalMatchups: 0, recent: [] };
  const matchupLines = (matchupMemory.recent || [])
    .map((item) => uiBullet('•', item.note))
    .join('\n');

  return [
    uiTitle('🧠', 'MLB Model Memory'),
    '',
    uiKV('📊', 'Total pick', summary.totalPicks),
    uiKV('✅', 'Benar', summary.correctPicks),
    uiKV('❌', 'Salah', summary.wrongPicks),
    uiKV('📈', 'Akurasi', `${summary.accuracy}%`),
    '',
    uiSection('🎚️', 'Confidence'),
    confidenceLines || 'Belum ada data confidence.',
    '',
    uiSection('🧩', 'Matchup memory'),
    uiKV('📌', 'Tracked matchups', matchupMemory.totalMatchups),
    matchupLines || 'Belum ada matchup berulang yang tersimpan.',
    '',
    uiSection('🧠', 'Recent learning'),
    summary.recentLog.length
      ? summary.recentLog.map((item) => `${item.correct ? '✅' : '❌'} ${item.note}`).join('\n')
      : 'Belum ada post-game learning.'
  ].join('\n');
}

function formatAgentStatus() {
  const summary = storage.getMemorySummary();

  return [
    uiTitle('🤖', 'MLB Analyst Agent'),
    '',
    uiKV('🟢', 'Status', config.analystAgent.enabled ? 'aktif' : 'mati'),
    uiKV('⚙️', 'Mode', config.analystAgent.mode),
    uiKV('🧠', 'Skill', ANALYST_SKILL_VERSION),
    uiKV('🤖', 'Model', config.openai.model),
    uiKV('💾', 'Memory', config.modelMemory ? 'aktif' : 'mati'),
    uiKV('💬', 'Interactive chat', config.interactiveAgent ? 'aktif' : 'mati'),
    uiKV('🏁', 'Post-game learning', config.postGameAlerts ? 'aktif' : 'mati'),
    uiKV('🧰', 'Tools', '/kb'),
    '',
    uiKV('📊', 'Memory sample', `${summary.totalPicks} pick | akurasi ${summary.accuracy}%`),
    '',
    config.analystAgent.enabled
      ? uiBullet('✅', 'Model deterministik membuat pick final; Agent menambah explanation dan risk context.')
      : uiBullet('⚠️', 'Agent mati, bot memakai model statistik deterministik.')
  ].join('\n');
}

function autoUpdateHelpText() {
  return [
    uiTitle('🔔', 'Auto Update MLB | help'),
    '',
    uiCommand('/autoupdate on', 'aktifkan update harian untuk chat ini'),
    uiCommand('/autoupdate off', 'matikan update harian'),
    uiCommand('/autoupdate time HH:mm', 'ubah jam update'),
    uiCommand('/autoupdate status', 'lihat status'),
    '',
    uiKV('🌐', 'Timezone', config.timezone),
    uiKV('🕒', 'Default time', config.dailyAlertTime)
  ].join('\n');
}

function formatAutoUpdateStatus(chatId) {
  const status = storage.getAutoUpdate(chatId);
  return [
    uiTitle('🔔', 'Auto Update MLB'),
    '',
    uiKV('🟢', 'Status', status.enabled ? 'aktif' : 'mati'),
    uiKV('🕒', 'Jam update', status.dailyTime || config.dailyAlertTime),
    uiKV('🌐', 'Timezone', config.timezone),
    uiKV('📤', 'Terakhir terkirim', status.lastSentDate || '-'),
    '',
    uiSection('📋', 'Command'),
    uiCommand('/autoupdate on', 'aktif'),
    uiCommand('/autoupdate off', 'mati'),
    uiCommand('/autoupdate time 20:00', 'ubah jam')
  ].join('\n');
}

async function handleAutoUpdateCommand(bot, chat, args) {
  const chatId = chat.id;
  const action = String(args[0] || 'status').toLowerCase();

  if (action === 'help') {
    await bot.sendMessage(chatId, autoUpdateHelpText());
    return;
  }

  if (action === 'status') {
    await bot.sendMessage(chatId, formatAutoUpdateStatus(chatId));
    return;
  }

  if (action === 'on') {
    const current = storage.getAutoUpdate(chatId);
    storage.setAutoUpdate(chat, {
      enabled: true,
      dailyTime: current.dailyTime || config.dailyAlertTime
    });
    await bot.sendMessage(chatId, formatAutoUpdateStatus(chatId));
    return;
  }

  if (action === 'off') {
    storage.setAutoUpdate(chat, { enabled: false });
    await bot.sendMessage(chatId, formatAutoUpdateStatus(chatId));
    return;
  }

  if (action === 'time') {
    const dailyTime = args[1];
    if (!isValidTime(dailyTime)) {
      await bot.sendMessage(chatId, uiKV('⌨️', 'Format jam salah', '/autoupdate time 20:00'));
      return;
    }

    storage.setAutoUpdate(chat, {
      enabled: true,
      dailyTime
    });
    await bot.sendMessage(chatId, formatAutoUpdateStatus(chatId));
    return;
  }

  await bot.sendMessage(chatId, autoUpdateHelpText());
}

function lineAlertsHelpText() {
  return [
    uiTitle('📈', 'Line Movement Alerts | help'),
    '',
    uiCommand('/linealerts on', 'aktifkan notifikasi line movement'),
    uiCommand('/linealerts off', 'matikan notifikasi line movement'),
    uiCommand('/linealerts status', 'lihat status'),
    '',
    uiSection('🔁', 'Alias'),
    uiCommand('/linemove on', 'aktif'),
    uiCommand('/linemove off', 'mati'),
    uiCommand('/linemove status', 'status')
  ].join('\n');
}

function formatLineAlertsStatus(chatId, stoppedCount = null) {
  const status = storage.getLineMovementAlerts(chatId);
  const settings = lineMonitorSettings();
  const lines = [
    uiTitle('📈', 'Line Movement Alerts'),
    '',
    uiKV('💬', 'Status chat', status.enabled ? 'aktif' : 'mati'),
    uiKV('🌐', 'Status global env', settings.enabled ? 'aktif' : 'mati'),
    uiKV('⏱️', 'Interval cek', `${settings.intervalMinutes} menit`),
    uiKV('📏', 'Threshold ML', `${settings.moneylineThreshold} cents`),
    uiKV('🔑', 'Odds API', settings.hasOddsApiKey ? 'tersedia' : 'belum diisi')
  ];

  if (stoppedCount !== null) {
    lines.push(uiKV('🛑', 'Monitor dihentikan', stoppedCount));
  }

  lines.push('', uiSection('📋', 'Command'), uiCommand('/linealerts on', 'aktif'), uiCommand('/linealerts off', 'mati'), uiCommand('/linealerts status', 'status'));
  return lines.join('\n');
}

async function handleLineAlertsCommand(bot, chat, args) {
  const chatId = chat.id;
  const action = String(args[0] || 'status').toLowerCase();

  if (action === 'help') {
    await bot.sendMessage(chatId, lineAlertsHelpText());
    return;
  }

  if (action === 'status') {
    await bot.sendMessage(chatId, formatLineAlertsStatus(chatId));
    return;
  }

  if (action === 'on') {
    storage.setLineMovementAlerts(chat, { enabled: true });
    await bot.sendMessage(chatId, formatLineAlertsStatus(chatId));
    return;
  }

  if (action === 'off') {
    storage.setLineMovementAlerts(chat, { enabled: false });
    const stoppedCount = stopLineMonitorForChat(chatId);
    await bot.sendMessage(chatId, formatLineAlertsStatus(chatId, stoppedCount));
    return;
  }

  await bot.sendMessage(chatId, lineAlertsHelpText());
}

const PREDICTION_CACHE_TTL_MS = 30 * 60 * 1000;

function isKnowledgeOnlyQuestion(question) {
  const text = String(question || '').toLowerCase();
  const knowledgePatterns = [
    /\b(apa itu|what is|define|definisi|artinya|meaning of)\b/,
    /\b(wrc\+|woba|xwoba|fip|xfip|siera|babip|ops|iso|whip|era|war)\b/,
    /\b(moneyline|run line|over.?under|implied probability|clv|closing line)\b/,
    /\b(sabermetric|sabermetrik|statistik|metric|formula|rumus)\b/,
    /\b(park factor|pythagorean|log5|expected|xba|xslg|barrel)\b/,
    /\b(bagaimana cara|how does|how to calculate|cara hitung)\b/,
    /\b(apa bedanya|difference between|beda|vs)\b.*\b(era|fip|ops|woba|whip)\b/
  ];
  return knowledgePatterns.some((pattern) => pattern.test(text));
}

function getCachedPredictions(chatId, dateYmd) {
  const key = `${chatId}:${dateYmd || 'today'}`;
  const cached = predictionCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > PREDICTION_CACHE_TTL_MS) {
    predictionCache.delete(key);
    return null;
  }
  return cached.predictions;
}

function setCachedPredictions(chatId, dateYmd, predictions) {
  const key = `${chatId}:${dateYmd || 'today'}`;
  predictionCache.set(key, { predictions, timestamp: Date.now() });
}

function predictionsHaveRawProbabilities(predictions) {
  return Array.isArray(predictions) && predictions.length > 0 && predictions.every((prediction) =>
    prediction?.away?.winProbabilityRaw != null && prediction?.home?.winProbabilityRaw != null
  );
}

async function handleLineupAlertsCommand(bot, chat, args) {
  const chatId = chat.id;
  const action = String(args[0] || 'status').toLowerCase();

  if (action === 'on') {
    storage.setMeta(`lineupAlerts:${chatId}`, '1');
    await bot.sendMessage(chatId, uiKV('🟢', 'Lineup alerts', 'aktif — notifikasi saat lineup confirmed'));
    return;
  }

  if (action === 'off') {
    storage.setMeta(`lineupAlerts:${chatId}`, '0');
    const stopped = stopLineupMonitorForChat(chatId);
    await bot.sendMessage(chatId, [
      uiKV('🔴', 'Lineup alerts', 'mati'),
      stopped > 0 ? uiKV('🛑', 'Monitor dihentikan', stopped) : null
    ].filter(Boolean).join('\n'));
    return;
  }

  const enabled = storage.getMeta(`lineupAlerts:${chatId}`, '1') !== '0';
  const settings = lineupMonitorSettings();
  await bot.sendMessage(chatId, [
    uiTitle('📋', 'Lineup Monitor'),
    '',
    uiKV('🟢', 'Status', enabled ? 'aktif' : 'mati'),
    uiKV('⏱️', 'Interval cek', `${settings.intervalMinutes} menit`),
    '',
    uiSection('📋', 'Command'),
    uiCommand('/lineups on', 'aktifkan notifikasi lineup'),
    uiCommand('/lineups off', 'matikan notifikasi lineup'),
    '',
    uiBullet('💡', 'Bot akan kirim alert saat lineup resmi terdeteksi dari MLB StatsAPI (biasanya 1-3 jam sebelum game).')
  ].join('\n'));
}

async function handlePicksCommand(bot, chatId, question, dateYmd = dateInTimezone(config.timezone)) {
  await bot.sendMessage(chatId, uiKV('🏆', 'Generating Top 5 picks...', dateYmd));
  storage.appendChatMessage(chatId, 'user', question);

  let predictions = getCachedPredictions(chatId, dateYmd);
  if (!predictionsHaveRawProbabilities(predictions)) {
    // Generate only when the cache is missing or predates winProbabilityRaw.
    // Work with the in-memory version so raw conviction is preserved for /picks.
    predictions = await getMlbPredictions(dateYmd, config.modelMemory ? storage.getMemory() : {});
    predictions = predictions || [];
  }

  // Re-run market context on cached predictions too. Cached odds can age past the
  // freshness window; stale prices must refresh or get downgraded before ledger.
  await attachMarketContext(predictions);
  await attachNewsContext(config, predictions, storage);
  applyNewsRiskVeto(predictions);
  applyRollingClvGate(predictions);
  persistNewsFeatures(dateYmd, predictions);
  storage.savePredictions(dateYmd, predictions);
  setCachedPredictions(chatId, dateYmd, predictions);

  // Record each VALUE bet at decision time (idempotent on game+market) so the
  // /ledger can later settle it to units P/L. NO BET / leans are skipped inside
  // recordBet. Errors here must never block the /picks answer.
  for (const prediction of predictions) {
    try {
      // Pass dateYmd explicitly: raw predictGame objects have no dateYmd field,
      // so relying on prediction.dateYmd would store an empty ledger date.
      storage.recordBet(prediction, dateYmd);
    } catch (error) {
      console.error('recordBet failed:', error.message);
    }
  }

  const answer = await answerInteractiveQuestion(config, {
    question,
    dateYmd,
    predictions,
    memorySummary: storage.getMemorySummary(),
    knowledgeContext: '',
    conversationHistory: storage.getChatHistory(chatId, 10)
  }).catch((error) => {
    console.error('Picks command error:', error.message);
    return null;
  });

  const response = answer ||
    uiBullet('⚠️', 'Agent belum bisa menjawab sekarang. Coba lagi atau pastikan OPENAI_API_KEY aktif.');

  storage.appendChatMessage(chatId, 'assistant', response);
  await bot.sendMessage(chatId, response);
  console.log(`Picks command handled for ${chatId}.`);
}

async function askAgent(bot, chatId, question, dateYmd = dateInTimezone(config.timezone)) {
  if (!question.trim()) {
    await bot.sendMessage(
      chatId,
      [
        uiTitle('💬', 'Ask Analyst Agent | help'),
        '',
        uiKV('⌨️', 'Format', '/ask pertanyaan'),
        '',
        uiSection('💡', 'Contoh'),
        uiCommand('/ask best 5 top pick for today', 'top pick ringkas'),
        uiCommand('/ask game mana yang edge-nya paling kuat hari ini?', 'edge terkuat'),
        uiCommand('/ask kenapa Yankees dipilih?', 'alasan pick'),
        uiCommand('/ask apa itu wRC+?', 'sabermetrics'),
        uiCommand('/ask upset risk terbesar hari ini?', 'risk upset')
      ].join('\n')
    );
    return;
  }

  await bot.sendMessage(chatId, uiKV('🤖', 'Analyst Agent thinking...', dateYmd));
  storage.appendChatMessage(chatId, 'user', question);

  const knowledgeOnly = isKnowledgeOnlyQuestion(question);
  let predictions;

  if (knowledgeOnly) {
    predictions = getCachedPredictions(chatId, dateYmd) || [];
  } else {
    predictions = getCachedPredictions(chatId, dateYmd);
    if (!predictions) {
      predictions = await getMlbPredictions(dateYmd, config.modelMemory ? storage.getMemory() : {});
      predictions = predictions || [];
      await attachMarketContext(predictions);
      setCachedPredictions(chatId, dateYmd, predictions);
    }
  }

  if (!knowledgeOnly) {
    await attachNewsContext(config, predictions, storage);
    applyNewsRiskVeto(predictions);
    applyRollingClvGate(predictions);
    persistNewsFeatures(dateYmd, predictions);
    storage.savePredictions(dateYmd, predictions);
    setCachedPredictions(chatId, dateYmd, predictions);
  }

  const [knowledgeContext] = await Promise.all([
    fetchKnowledgeContext(question)
  ]);

  const conversationHistory = storage.getChatHistory(chatId, 10);

  const answer = await answerInteractiveQuestion(config, {
    question,
    dateYmd,
    predictions,
    memorySummary: storage.getMemorySummary(),
    knowledgeContext,
    conversationHistory
  }).catch((error) => {
    console.error('Interactive Agent error:', error.message);
    return null;
  });

  const response = answer ||
    uiBullet('⚠️', 'Agent belum bisa menjawab sekarang. Coba cek /today dulu atau pastikan OPENAI_API_KEY dan ANALYST_AGENT aktif.');

  storage.appendChatMessage(chatId, 'assistant', response);
  await bot.sendMessage(chatId, response);
  console.log(`Interactive question handled for ${chatId}.`);
}

function shouldTriggerCalibrationRetrain(settledCount, alreadyQueued = false) {
  return !alreadyQueued && settledCount > 0 && settledCount % 25 === 0;
}

function maybeQueueCalibrationRetrain(alreadyQueued = false) {
  // Governance: do NOT auto-retrain or promote calibration artifacts from post-game.
  // Only emit a proposal/outbox notice when the sample gate fires. Operator must
  // run chronological OOF fit and explicit promotion separately.
  let settledCount = 0;
  try {
    settledCount = storage.readLedger({ status: 'settled', includeArchived: true }).length;
  } catch (error) {
    console.error('Calibration retrain check failed:', error.message);
    return false;
  }

  if (!shouldTriggerCalibrationRetrain(settledCount, alreadyQueued)) return false;

  const now = new Date().toISOString();
  const proposal = {
    type: 'calibration_retrain_proposal',
    settledCount,
    createdAt: now,
    status: 'proposal_only',
    note: 'Automatic promotion disabled. Run chronological OOF calibration and promote explicitly.'
  };
  console.log(
    `Calibration retrain PROPOSAL only after ${settledCount} settled bets (auto-apply disabled).`
  );
  try {
    storage.enqueueOutbox('calibration_retrain_proposal', String(settledCount), proposal);
  } catch (error) {
    console.error('Failed to record calibration proposal:', error.message);
  }

  return true;
}

/**
 * CLV side must match the immutable value bet side (ledger), not display pick.
 * VALUE bets refuse display-pick fallback so CLV and P/L share one side.
 */
function resolveClvSide(prediction, storageRef = storage) {
  const hasValueBet =
    prediction?.betDecision?.status === 'VALUE' ||
    Boolean(prediction?.valuePick?.side) ||
    prediction?.valuePick?.teamId != null;
  return resolveClvSideCore(prediction, storageRef, { requireValueSide: hasValueBet });
}

function computeClvFromOdds(openingLine, closingLine) {
  const openingImplied = americanImpliedProbability(openingLine);
  const closingImplied = americanImpliedProbability(closingLine);
  if (!Number.isFinite(openingImplied) || !Number.isFinite(closingImplied)) return null;
  // CLV as implied-probability edge: positive means recommendation beat close.
  return Math.round((closingImplied - openingImplied) * 1000) / 10;
}

function computeMoneylineClv(prediction, gamePk, side) {
  if (side !== 'home' && side !== 'away') return null;
  const openingOdds = prediction.openingOdds;
  if (!openingOdds) return null;
  const closingLine = resolveClosingLine(gamePk, side);
  if (!Number.isFinite(closingLine)) return null;
  const openingLine = side === 'home' ? openingOdds.homeMoneyline : openingOdds.awayMoneyline;
  return computeClvFromOdds(openingLine, closingLine);
}

function computeShadowMoneylineClv(shadowRow, gamePk) {
  if (!shadowRow || (shadowRow.side !== 'home' && shadowRow.side !== 'away')) {
    return { clv: null, closingOdds: null };
  }
  const closingOdds = resolveClosingLine(gamePk, shadowRow.side);
  if (!Number.isFinite(closingOdds)) return { clv: null, closingOdds: null };
  return {
    clv: computeClvFromOdds(Number(shadowRow.odds), closingOdds),
    closingOdds
  };
}

async function evaluatePostGames(dateYmd, { markProcessed = true, includeProcessed = false } = {}) {
  const results = await getFinalGameResults(dateYmd);
  const evaluations = [];
  let calibrationRetrainQueued = false;

  for (const result of results) {
    const prediction = storage.getPrediction(result.gamePk);
    if (!prediction) continue;

    const openBet = storage.getOpenBet(result.gamePk, 'moneyline');
    const openShadowBet = storage.getOpenShadowBet(result.gamePk, 'moneyline');
    const hasOpenBet = Boolean(openBet);
    const hasOpenShadowBet = Boolean(openShadowBet);
    // Skip only when processed and no stranded real/paper decision needs recovery.
    if (
      prediction.postGameProcessed &&
      markProcessed &&
      !includeProcessed &&
      !hasOpenBet &&
      !hasOpenShadowBet
    ) {
      continue;
    }

    const correct = prediction.pick.id === result.winner.id;
    const clvSide = resolveClvSide(prediction, storage);
    const clv = computeMoneylineClv(prediction, result.gamePk, clvSide);
    const shadowClose = computeShadowMoneylineClv(openShadowBet, result.gamePk);

    const shouldProcess =
      markProcessed && (!prediction.postGameProcessed || hasOpenBet || hasOpenShadowBet);

    let learned = false;
    if (shouldProcess) {
      const outcome = storage.processPostGameOutcome(prediction, result, {
        enabled: config.modelMemory,
        clv,
        shadowClv: shadowClose.clv,
        shadowClosingOdds: shadowClose.closingOdds
      });
      // Only real memory/outcome + real settlement count as "learned" for
      // evolution triggers. Shadow settlement is paper-only and must never
      // independently drive evolution, auto-retrain, or guardrail reopening.
      learned =
        Boolean(outcome.processed) ||
        Boolean(outcome.settled);
      if (outcome.error) {
        console.error('processPostGameOutcome failed:', outcome.error);
      }
      if (outcome.settled) {
        calibrationRetrainQueued = maybeQueueCalibrationRetrain(calibrationRetrainQueued);
      }
    }

    evaluations.push({
      prediction,
      result,
      correct,
      learned,
      clv,
      clvSide,
      shadowClv: shadowClose.clv,
      shadowSide: openShadowBet?.side || null
    });
  }

  return evaluations;
}

function rollingWinRate(days = 3) {
  const log = storage.readMemory().learningLog || [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = log.filter(
    (entry) => entry.at && typeof entry.correct === 'boolean' && new Date(entry.at).getTime() >= cutoff
  );
  if (recent.length === 0) return null;
  const correct = recent.filter((entry) => entry.correct).length;
  return { correct, total: recent.length, rate: Math.round((correct / recent.length) * 100), days };
}

function formatPostGameRecap(dateYmd, evaluations) {
  if (evaluations.length === 0) {
    return [
      uiTitle('🏁', 'MLB Post-game Recap'),
      uiKV('📅', 'Tanggal', dateYmd),
      '',
      uiBullet('⚠️', 'Belum ada game final dengan pick pre-game yang tersimpan.'),
      uiBullet('📌', 'Pastikan /today, /deep, atau auto-alert sudah jalan sebelum game dimulai.')
    ].join('\n');
  }

  const correctCount = evaluations.filter((item) => item.correct).length;
  const slateRate = Math.round((correctCount / evaluations.length) * 100);
  const memory = storage.getMemorySummary();
  const rolling = rollingWinRate(3);
  const separator = UI_LINE;

  // Trend arrow: how the recent 3-day form compares to the all-time baseline.
  let trend = '';
  if (rolling && memory.totalPicks > 0) {
    const delta = rolling.rate - memory.accuracy;
    if (delta >= 5) trend = ` ⬆️ +${delta}%`;
    else if (delta <= -5) trend = ` ⬇️ ${delta}%`;
    else trend = ' ➡️ stabil';
  }

  const lines = [
    uiTitle('🏁', 'MLB Post-game Recap'),
    uiKV('📅', 'Tanggal', dateYmd),
    '',
    uiSection('📊', 'Performa'),
    uiKV('🎯', 'Slate hari ini', `${correctCount}/${evaluations.length} (${slateRate}%)`),
    rolling
      ? uiKV('🔥', '3 hari terakhir', `${rolling.rate}% (${rolling.correct}/${rolling.total})${trend}`)
      : null,
    uiKV('📈', 'Keseluruhan', `${memory.accuracy}% (${memory.correctPicks}/${memory.totalPicks} pick)`),
    '',
    separator
  ].filter(Boolean);

  for (const item of evaluations) {
    const { prediction, result, correct, learned } = item;
    const scoreLine = `${result.away.abbreviation || result.away.name} ${result.away.score} - ${result.home.score} ${result.home.abbreviation || result.home.name}`;
    const memoryLine = learned
      ? correct
        ? 'Memory: pick benar; matchup pattern disimpan sebagai sinyal kecil.'
        : `Memory: pick salah disimpan; matchup pattern mencatat ${result.winner.abbreviation || result.winner.name} menang tanpa auto-bias berlebihan.`
      : 'Memory: game ini sudah pernah diproses.';

    lines.push(
      [
        uiKV('🏟️', 'Matchup', prediction.matchup),
        uiKV('📍', 'Final', scoreLine),
        uiKV('🏆', 'Winner', result.winner.name),
        uiKV('🎯', 'Pick', `${prediction.pick.name} | ${prediction.pick.winProbability}%`),
        uiBullet(correct ? '✅' : '❌', correct ? 'Benar' : 'Salah'),
        uiBullet('🧠', memoryLine)
      ].filter(Boolean).join('\n')
    );
    lines.push(separator);
  }

  lines.push(uiBullet('⚠️', 'Memory adalah adjustment kecil, bukan jaminan hasil berikutnya.'));
  return lines.join('\n\n');
}

async function handleMessage(bot, message) {
  const chat = message.chat;
  const chatId = chat.id;
  const text = message.text?.trim() || '';
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand?.replace(/@.+$/, '').toLowerCase();

  if (command === '/chatid') {
    await bot.sendMessage(chatId, uiKV('💬', 'Chat ID', chatId));
    return;
  }

  if (!isAllowed(chatId)) {
    await bot.sendMessage(chatId, uiBullet('⛔', 'Chat ini belum diizinkan. Tambahkan ID ini ke ALLOWED_CHAT_IDS.'));
    return;
  }

  if (command === '/start' || command === '/help') {
    await bot.sendMessage(chatId, helpText());
    return;
  }

  if (command === '/subscribe') {
    storage.addSubscriber(chat, {
      autoUpdate: {
        enabled: true,
        dailyTime: storage.getAutoUpdate(chatId).dailyTime || config.dailyAlertTime
      }
    });
    await bot.sendMessage(chatId, formatAutoUpdateStatus(chatId));
    return;
  }

  if (command === '/unsubscribe') {
    storage.removeSubscriber(chatId);
    await bot.sendMessage(chatId, uiBullet('🛑', 'Auto-alert dimatikan untuk chat ini.'));
    return;
  }

  if (command === '/today') {
    const maybeDate = args[0];
    const dateYmd = isValidDateYmd(maybeDate) ? maybeDate : dateInTimezone(config.timezone);
    if (!acquireCommandLock(chatId, 'today')) return;
    try {
      const { text: alertText, predictions } = await buildAlertPayload(dateYmd, { includeAdvanced: false });
      const gameButtons = predictions.slice(0, 12).map((p) => [{
        text: `${p.away.abbreviation || p.away.name} @ ${p.home.abbreviation || p.home.name}`,
        callback_data: `${PREDICT_CALLBACK_PREFIX}${dateYmd}:${p.gamePk}`
      }]);
      await bot.sendMessage(chatId, alertText, {
        reply_markup: gameButtons.length ? { inline_keyboard: gameButtons } : undefined
      });
      maybeStartLineMonitor(predictions, chatId, dateYmd);
      console.log(`Alert ${dateYmd} sent to ${chatId}.`);
    } finally {
      releaseCommandLock(chatId, 'today');
    }
    return;
  }

  if (command === '/deep') {
    const maybeDate = args[0];
    const dateYmd = isValidDateYmd(maybeDate) ? maybeDate : dateInTimezone(config.timezone);
    if (!acquireCommandLock(chatId, 'deep')) return;
    try {
      const { text: alertText, predictions } = await buildAlertPayload(dateYmd, { includeAdvanced: true });
      await bot.sendMessage(chatId, alertText);
      maybeStartLineMonitor(predictions, chatId, dateYmd);
      console.log(`Deep alert ${dateYmd} sent to ${chatId}.`);
    } finally {
      releaseCommandLock(chatId, 'deep');
    }
    return;
  }

  if (command === '/date') {
    const dateYmd = args[0];
    if (!isValidDateYmd(dateYmd)) {
      await bot.sendMessage(chatId, uiKV('⌨️', 'Format', '/date YYYY-MM-DD'));
      return;
    }

    if (!acquireCommandLock(chatId, 'date')) return;
    try {
      await sendAlert(bot, chatId, dateYmd);
    } finally {
      releaseCommandLock(chatId, 'date');
    }
    return;
  }

  if (command === '/game') {
    const teamFilter = args.join(' ').trim();
    if (!teamFilter) {
      await bot.sendMessage(chatId, uiKV('⌨️', 'Format', '/game Yankees atau /game LAD'));
      return;
    }

    if (!acquireCommandLock(chatId, 'game')) return;
    try {
      await sendAlert(bot, chatId, dateInTimezone(config.timezone), { teamFilter, includeAdvanced: true });
    } finally {
      releaseCommandLock(chatId, 'game');
    }
    return;
  }

  if (command === '/predict') {
    await sendPythonPrediction(bot, chatId, text);
    return;
  }

  if (command === '/kb' || command === '/knowledge') {
    const query = args.join(' ').trim();
    if (!query) {
      await bot.sendMessage(
        chatId,
        [
          uiTitle('📚', 'Knowledge Base'),
          '',
          uiSection('🔎', 'Cara pakai'),
          uiBullet('•', `/kb <topik> — contoh: /kb weather wind di Wrigley`),
          uiBullet('•', 'Topik: weather, umpire, park, bullpen, lineup, platoon, sharp money, travel')
        ].join('\n')
      );
      return;
    }
    await sendKnowledgeAnswer(bot, chatId, query);
    return;
  }

  if (command === '/picks') {
    const { dateYmd, question } = buildPicksQuestion(args);
    if (!acquireCommandLock(chatId, 'picks')) return;
    try {
      await handlePicksCommand(bot, chatId, question, dateYmd);
    } finally {
      releaseCommandLock(chatId, 'picks');
    }
    return;
  }

  if (command === '/ledger') {
    if (!acquireCommandLock(chatId, 'ledger')) return;
    try {
      const rows = storage.readLedger({ includeArchived: true });
      await bot.sendMessage(chatId, formatLedgerReport(rows, { clvGate: config.clvGate }));
    } finally {
      releaseCommandLock(chatId, 'ledger');
    }
    return;
  }

  if (command === '/shadow') {
    if (!acquireCommandLock(chatId, 'shadow')) return;
    try {
      const rows = storage.readShadowLedger();
      await bot.sendMessage(chatId, formatShadowLedgerReport(rows));
    } finally {
      releaseCommandLock(chatId, 'shadow');
    }
    return;
  }

  if (command === '/analyze') {
    if (!acquireCommandLock(chatId, 'analyze')) return;
    try {
      await askAgent(bot, chatId, buildAnalyzeQuestion(args));
    } finally {
      releaseCommandLock(chatId, 'analyze');
    }
    return;
  }

  if (command === '/news') {
    const { dateYmd, question } = buildNewsQuestion(args);
    if (!acquireCommandLock(chatId, 'news')) return;
    try {
      await askAgent(bot, chatId, question, dateYmd);
    } finally {
      releaseCommandLock(chatId, 'news');
    }
    return;
  }

  if (command === '/ask') {
    if (!acquireCommandLock(chatId, 'ask')) return;
    try {
      await askAgent(bot, chatId, args.join(' '));
    } finally {
      releaseCommandLock(chatId, 'ask');
    }
    return;
  }

  if (command === '/autoupdate') {
    await handleAutoUpdateCommand(bot, chat, args);
    return;
  }

  if (command === '/sendalert') {
    const dateYmd = dateInTimezone(config.timezone);
    const sent = await sendAlertToAll(bot, dateYmd);
    await bot.sendMessage(chatId, sent > 0 ? uiKV('📤', 'Alert terkirim', `${sent} chat`) : uiBullet('⚠️', 'Belum ada subscriber/chat id target.'));
    return;
  }

  if (command === '/linecheck') {
    await handleLineCheckCommand(bot, chatId);
    return;
  }

  if (command === '/linealerts' || command === '/linemove') {
    await handleLineAlertsCommand(bot, chat, args);
    return;
  }

  if (command === '/lineups') {
    await handleLineupAlertsCommand(bot, chat, args);
    return;
  }

  if (command === '/evolve' || command === '/evolution' || command === '/audit') {
    await handleEvolve(bot, chatId);
    return;
  }

  if (command === '/postgame') {
    const maybeDate = args[0];
    const dateYmd = isValidDateYmd(maybeDate) ? maybeDate : dateInTimezone(config.timezone);
    await bot.sendMessage(chatId, uiKV('⏳', 'Mengecek final game MLB', dateYmd));
    const evaluations = await evaluatePostGames(dateYmd, {
      markProcessed: true,
      includeProcessed: true
    });
    await bot.sendMessage(chatId, formatPostGameRecap(dateYmd, evaluations));
    return;
  }

  if (command === '/memory') {
    await bot.sendMessage(chatId, formatMemorySummary());
    return;
  }

  if (command === '/agent') {
    await bot.sendMessage(chatId, formatAgentStatus());
    return;
  }

  if (command === '/skill') {
    await bot.sendMessage(chatId, buildAnalystSkillSummary());
    return;
  }

  if (command === '/clear') {
    storage.clearChatHistory(chatId);
    await bot.sendMessage(chatId, uiBullet('🧹', 'Conversation history cleared. Mulai fresh.'));
    return;
  }

  if (text && !text.startsWith('/') && config.interactiveAgent) {
    await askAgent(bot, chatId, text);
    return;
  }

  await bot.sendMessage(chatId, helpText());
}

async function handleEvolveCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Processing...' }).catch(() => {});
  if (!chatId) return;
  // /evolve is now a single all-in-one pipeline; any legacy button runs it.
  await handleEvolve(bot, chatId);
}

async function handleCallbackQuery(bot, callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  if (!chatId) return;

  if (!isAllowed(chatId)) {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Chat ini belum diizinkan.',
      show_alert: true
    });
    return;
  }

  const data = callbackQuery.data || '';
  if (data.startsWith(PREDICT_CALLBACK_PREFIX)) {
    await handlePredictCallback(bot, callbackQuery);
    return;
  }

  if (data.startsWith(EVOLVE_CALLBACK_PREFIX)) {
    await handleEvolveCallback(bot, callbackQuery);
    return;
  }

  if (data.startsWith(LEGACY_PREDICT_CALLBACK_PREFIX)) {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Tombol ini dari menu lama. Kirim /predict lagi untuk live schedule.',
      show_alert: true
    });
    return;
  }

  await bot.answerCallbackQuery(callbackQuery.id, {
    text: 'Aksi tombol tidak dikenal.',
    show_alert: false
  });
}

const processedUpdateIds = new Set();
const commandLocks = new Map();

const COMMAND_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

function acquireCommandLock(chatId, command) {
  const key = `${chatId}:${command}`;
  const existing = commandLocks.get(key);
  if (existing) {
    // Release stale locks (TTL expired)
    if (Date.now() - existing > COMMAND_LOCK_TTL_MS) {
      commandLocks.delete(key);
    } else {
      return false;
    }
  }
  commandLocks.set(key, Date.now());
  return true;
}

function releaseCommandLock(chatId, command) {
  commandLocks.delete(`${chatId}:${command}`);
}

async function processTelegramUpdate(bot, update) {
  if (update.update_id !== undefined) {
    if (processedUpdateIds.has(update.update_id)) return;
    processedUpdateIds.add(update.update_id);
    if (processedUpdateIds.size > 500) {
      const ids = [...processedUpdateIds];
      for (const id of ids.slice(0, ids.length - 200)) processedUpdateIds.delete(id);
    }
    storage.setLastUpdateId(update.update_id);
  }

  if (update.message) {
    await handleMessage(bot, update.message).catch(async (error) => {
      console.error(error);
      await bot.sendMessage(update.message.chat.id, uiKV('⚠️', 'Error', error.message)).catch(() => {});
    });
  }

  if (update.callback_query) {
    await handleCallbackQuery(bot, update.callback_query).catch(async (error) => {
      console.error(error);
      const chatId = update.callback_query.message?.chat?.id;
      if (chatId) {
        await bot.sendMessage(chatId, uiKV('⚠️', 'Error', error.message)).catch(() => {});
      }
    });
  }
}

async function poll(bot) {
  let offset = storage.getLastUpdateId() ? storage.getLastUpdateId() + 1 : undefined;
  console.log('Telegram bot polling aktif.');

  while (true) {
    try {
      const updates = await bot.getUpdates({ offset, timeout: 30 });
      for (const update of updates) {
        offset = update.update_id + 1;
        // Process concurrently so a slow command (e.g. /deep fetching odds + agent
        // analysis) does not block polling and make other commands appear dead.
        processTelegramUpdate(bot, update).catch((error) => {
          console.error('Update processing error:', error);
        });
      }
    } catch (error) {
      console.error('Polling error:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function startWebhookMode(bot) {
  const webhook = await setupWebhook(bot, {
    webhookUrl: config.telegramWebhook.url,
    port: config.telegramWebhook.port,
    secret: config.telegramWebhook.secret,
    onUpdate: (update) => processTelegramUpdate(bot, update)
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} diterima. Menghapus Telegram webhook dan menutup server...`);
    await webhook.close({ deleteWebhook: true });
    process.exit(0);
  };

  process.once('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      console.error('Graceful shutdown gagal:', error.message);
      process.exit(1);
    });
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      console.error('Graceful shutdown gagal:', error.message);
      process.exit(1);
    });
  });

  await new Promise(() => {});
}

async function processPendingPostGames(bot) {
  if (postGameCheckRunning) return;
  // NOTE: settlement, memory learning and auto-evolution must run regardless of
  // whether there are chat recipients. Only the recap *send* is gated on having
  // targets below — the old early-return here left open bets unsettled and the
  // ledger/units P/L frozen in allowlist-only setups with no TELEGRAM_CHAT_ID.
  const hasChatTargets = targetChatIds().length > 0;

  postGameCheckRunning = true;
  let newGamesLearned = 0;
  try {
    for (const dateYmd of storage.listPendingPredictionDates()) {
      const evaluations = await evaluatePostGames(dateYmd, { markProcessed: true });
      if (evaluations.length === 0) continue;

      newGamesLearned += evaluations.filter((evaluation) => evaluation.learned).length;
      if (hasChatTargets) {
        const text = formatPostGameRecap(dateYmd, evaluations);
        const sent = await sendTextToAll(bot, text);
        console.log(`Post-game recap ${dateYmd} terkirim ke ${sent} chat.`);
      } else {
        console.log(`Post-game ${dateYmd}: ${evaluations.length} game(s) settled/learned (no chat targets, recap skipped).`);
      }
    }

    if (newGamesLearned > 0) {
      try {
        // Auto-evolution is always on: a full cycle (backfill + ingest +
        // calibration + candidates) followed by a safe-apply audit runs after
        // every post-game learning pass so the edge improves automatically.
        console.log(`Post-game: ${newGamesLearned} new game(s) learned. Running full evolution cycle...`);
        await runPythonModule('src.evolution.evolution_engine', ['--run-cycle'], {
          timeoutMessage: 'Auto evolution cycle timeout. Skipped.',
          timeoutMs: 120_000
        });
        await runPythonModule('src.evolution.evolution_audit', ['--summary', '--apply-safe', '--update-memory'], {
          timeoutMessage: 'Auto audit timeout. Skipped.',
          timeoutMs: 120_000
        });
        console.log('Auto evolution cycle + audit completed.');
      } catch (error) {
        console.error('Auto evolution cycle after post-game failed:', error.message);
      }
    }
  } finally {
    postGameCheckRunning = false;
  }
}

function lineupAutoStartIntervalMs() {
  const configured = Number(process.env.LINEUP_AUTO_START_INTERVAL_MIN);
  if (Number.isFinite(configured) && configured > 0) return configured * 60 * 1000;
  return 30 * 60 * 1000;
}

async function processLineupAutoStart(bot) {
  if (lineupAutoStartRunning) return;
  if (!lineupMonitorSettings().enabled) return;
  const chatIds = targetChatIds();
  if (chatIds.length === 0) return;

  const nowMs = Date.now();
  if (nowMs - lastLineupAutoStartAt < lineupAutoStartIntervalMs()) return;

  lineupAutoStartRunning = true;
  lastLineupAutoStartAt = nowMs;
  try {
    const today = dateInTimezone(config.timezone);
    const modelMemory = config.modelMemory ? storage.getMemory() : {};
    const predictions = await getMlbPredictions(today, modelMemory);
    if (!predictions.length) return;

    for (const chatId of chatIds) {
      startLineupMonitor(predictions, chatId);
    }
    console.log(`Lineup auto-monitor armed for ${chatIds.length} chat(s), ${predictions.length} game(s).`);
  } catch (error) {
    console.error('Lineup auto-monitor start failed:', error.message);
  } finally {
    lineupAutoStartRunning = false;
  }
}

async function processAutoUpdates(bot) {
  if (autoUpdateCheckRunning) return;

  const today = dateInTimezone(config.timezone);
  const now = timeInTimezone(config.timezone);
  const targets = targetAutoUpdateChats().filter(
    (target) => now >= target.dailyTime && target.lastSentDate !== today
  );

  if (targets.length === 0) return;

  autoUpdateCheckRunning = true;
  try {
    const { text, predictions } = await buildAlertPayload(today);
    for (const target of targets) {
      await bot
        .sendMessage(target.chatId, text)
        .then(() => {
          maybeStartLineMonitor(predictions, target.chatId, today);
          if (target.legacyEnv) {
            storage.setLastAutoAlertDate(today);
          } else {
            storage.setAutoUpdateLastSent(target.chatId, today);
          }
          console.log(`Auto-update ${today} terkirim ke ${target.chatId}.`);
        })
        .catch((error) => {
          console.error(`Gagal auto-update ke ${target.chatId}:`, error.message);
        });
    }
  } finally {
    autoUpdateCheckRunning = false;
  }
}

function formatWeeklyRecap(stats) {
  const lines = [
    uiTitle('📊', 'Weekly Performance Recap'),
    uiKV('📅', 'Periode', `${stats.startDate} — ${stats.endDate}`),
    '',
    uiKV('🎯', 'Total picks', stats.totalPicks),
    uiKV('✅', 'Benar', stats.correct),
    uiKV('❌', 'Salah', stats.wrong),
    uiKV('📈', 'Akurasi', `${stats.accuracy}%`),
    ''
  ];

  if (stats.bestPick) {
    lines.push(uiKV('🏆', 'Best pick', stats.bestPick));
  }
  if (stats.worstPick) {
    lines.push(uiKV('💔', 'Worst miss', stats.worstPick));
  }

  lines.push('');
  lines.push(uiSection('🎚️', 'By confidence'));
  for (const [level, data] of Object.entries(stats.byConfidence)) {
    if (data.total > 0) {
      lines.push(uiKV('•', level, `${data.correct}/${data.total} | ${Math.round((data.correct / data.total) * 100)}%`));
    }
  }

  lines.push('');
  lines.push(uiBullet('📌', 'Recap otomatis setiap minggu. Gunakan /memory untuk detail lengkap.'));
  return lines.join('\n');
}

function computeWeeklyStats() {
  // Build the 7-day window in config.timezone, matching how predictions are
  // keyed (dateInTimezone). Using UTC toISOString() dates here could shift the
  // window a day on a server whose local/UTC zone differs from config.timezone.
  // Anchor at UTC noon so day arithmetic never crosses a DST/midnight boundary.
  const todayYmd = dateInTimezone(config.timezone);
  const anchor = new Date(`${todayYmd}T12:00:00Z`);
  const dates = [];
  for (let i = 7; i >= 1; i--) {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  let totalPicks = 0;
  let correct = 0;
  let wrong = 0;
  const byConfidence = { high: { total: 0, correct: 0 }, medium: { total: 0, correct: 0 }, low: { total: 0, correct: 0 } };
  let bestPick = null;
  let worstPick = null;

  for (const dateYmd of dates) {
    const predictions = storage.listPredictionsByDate(dateYmd);
    for (const prediction of predictions) {
      if (!prediction.postGameProcessed) continue;
      totalPicks += 1;
      const log = (storage.state?.memory?.learningLog || []).find(
        (entry) => String(entry.gamePk) === String(prediction.gamePk)
      );
      if (!log) continue;

      if (log.correct) {
        correct += 1;
        if (!bestPick || (prediction.pick?.winProbability || 0) < (bestPick.prob || 100)) {
          bestPick = { label: `${prediction.matchup} — ${prediction.pick?.name}`, prob: prediction.pick?.winProbability };
        }
      } else {
        wrong += 1;
        if (!worstPick) {
          worstPick = `${prediction.matchup} — picked ${prediction.pick?.name}`;
        }
      }

      const conf = String(prediction.pick?.confidence || 'low').toLowerCase();
      if (byConfidence[conf]) {
        byConfidence[conf].total += 1;
        if (log.correct) byConfidence[conf].correct += 1;
      }
    }
  }

  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    totalPicks,
    correct,
    wrong,
    accuracy: totalPicks > 0 ? Math.round((correct / totalPicks) * 100) : 0,
    bestPick: bestPick?.label || null,
    worstPick,
    byConfidence
  };
}

async function processWeeklyRecap(bot) {
  // Evaluate BOTH the day-of-week and the hour in config.timezone. Mixing a
  // server-local getDay() with a timezone-local hour let the Sunday 09:00-10:00
  // window fire on the wrong calendar day (or be skipped) on a UTC-clock server.
  const now = new Date();
  const dayOfWeek = weekdayInTimezone(config.timezone, now);
  const hour = Number(timeInTimezone(config.timezone).split(':')[0]);

  if (dayOfWeek !== 0 || hour < 9 || hour > 10) return;

  const lastRecapDate = storage.getMeta('lastWeeklyRecapDate', '');
  const today = dateInTimezone(config.timezone);
  if (lastRecapDate === today) return;

  const stats = computeWeeklyStats();
  if (stats.totalPicks === 0) return;

  const text = formatWeeklyRecap(stats);
  await sendTextToAll(bot, text);
  storage.setMeta('lastWeeklyRecapDate', today);
  console.log(`Weekly recap sent: ${stats.correct}/${stats.totalPicks} accuracy.`);
}

// How early before first pitch we start capturing/refreshing the closing line.
// Wide enough that the bot will catch every game's pre-game line across normal
// poll cadence and restarts; narrow enough not to pull tomorrow's slate.
const CLOSING_REFRESH_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours

// Credit-saving throttle for the BACKGROUND closing-line capture (does not touch
// /picks freshness, which uses its own fetch). The Odds API free tier is only
// 500 credits/month and each fetch costs 2 (h2h+totals), so refreshing every
// poll for 3 hours burns the quota in days. Lines far from first pitch are not
// the closing line anyway — what we want is the LAST price near first pitch. So:
//   * within FINAL_WINDOW of first pitch: capture every cycle (nail the close),
//   * otherwise: capture at most once per MIN_INTERVAL.
// Both overridable via env for paid plans (set interval to 0 to disable throttle).
const CLOSING_CAPTURE_FINAL_WINDOW_MS = 40 * 60 * 1000; // 40 min before first pitch
function closingCaptureMinIntervalMs() {
  const configured = Number(process.env.CLOSING_CAPTURE_INTERVAL_MIN);
  if (Number.isFinite(configured) && configured >= 0) return configured * 60 * 1000;
  return 15 * 60 * 1000; // 15 minutes
}

// Pure predicate: should this prediction's line be captured/refreshed now?
// Eligible when the game has not started (startMs > now, the hard guard against
// overwriting a frozen closing line) and starts within the pre-game window.
function isClosingCaptureEligible(prediction, now = Date.now(), windowMs = CLOSING_REFRESH_WINDOW_MS) {
  const start = prediction?.startTime || prediction?.start || prediction?.gameTime;
  if (!start) return false;
  const startMs = new Date(start).getTime();
  if (!Number.isFinite(startMs) || startMs <= now) return false;
  return startMs - now <= windowMs;
}

// Pure predicate: given the eligible games, should we actually spend an API
// fetch right now? True when (a) we haven't fetched within minIntervalMs, or
// (b) any eligible game is inside the final window (where fresh closing matters).
function shouldCaptureClosingNow(
  soonGames,
  now,
  lastCaptureAt,
  { minIntervalMs = closingCaptureMinIntervalMs(), finalWindowMs = CLOSING_CAPTURE_FINAL_WINDOW_MS } = {}
) {
  if (!Array.isArray(soonGames) || soonGames.length === 0) return false;
  const anyNearFirstPitch = soonGames.some((game) => {
    const start = game?.startTime || game?.start || game?.gameTime;
    const startMs = new Date(start).getTime();
    return Number.isFinite(startMs) && startMs - now <= finalWindowMs;
  });
  if (anyNearFirstPitch) return true;
  if (minIntervalMs <= 0) return true;
  return now - (lastCaptureAt || 0) >= minIntervalMs;
}

// Last wall-clock time the background capture actually spent an API fetch.
let lastClosingCaptureAt = 0;

async function captureClosingLinesForUpcoming() {
  // Query a 2-day range (yesterday + today, local), not a single date: a game
  // listed under one date_ymd can start after local midnight, so a single-day
  // query scoped to local "today" silently misses tonight's slate (the games
  // are stored under the prior date). The start-time predicate does the real
  // filtering, so an over-broad range is safe.
  const today = dateInTimezone(config.timezone);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const sinceDate = today < yesterday ? today : yesterday;
  const predictions = storage.listPredictionsSinceDate(sinceDate);
  if (!predictions.length) return;

  const now = Date.now();
  // Capture/refresh the line for ANY game that has not started yet and starts
  // within the pre-game window. We deliberately do NOT skip games that already
  // have a closing snapshot: refreshing on each poll means the LAST value before
  // first pitch wins (the true closing proxy), and a missed poll or bot restart
  // no longer permanently loses a game's closing line.
  const soonGames = predictions.filter((p) => isClosingCaptureEligible(p, now));

  // Throttle the actual API spend: skip the fetch unless enough time has passed
  // OR a game is near first pitch (where the closing proxy matters). This is the
  // main Odds API credit-saver — see shouldCaptureClosingNow.
  if (!shouldCaptureClosingNow(soonGames, now, lastClosingCaptureAt)) return;

  if (soonGames.length > 0) {
    lastClosingCaptureAt = now;
    const result = await captureClosingLines(soonGames);
    if (result.captured > 0) {
      console.log(`Closing lines captured/refreshed for ${result.captured} game(s).`);
    }
  }
}

function startScheduler(bot) {
  processAutoUpdates(bot).catch((error) => {
    console.error('Auto-update check error:', error.message);
  });
  processLineupAutoStart(bot).catch((error) => {
    console.error('Lineup auto-monitor error:', error.message);
  });

  setInterval(() => {
    processAutoUpdates(bot).catch((error) => {
      console.error('Auto-update check error:', error.message);
    });
    processLineupAutoStart(bot).catch((error) => {
      console.error('Lineup auto-monitor error:', error.message);
    });
    processWeeklyRecap(bot).catch((error) => {
      console.error('Weekly recap error:', error.message);
    });
    captureClosingLinesForUpcoming().catch((error) => {
      console.error('Closing line capture error:', error.message);
    });
  }, 60_000);

  if (config.postGameAlerts) {
    processPendingPostGames(bot).catch((error) => {
      console.error('Post-game check error:', error.message);
    });

    setInterval(() => {
      processPendingPostGames(bot).catch((error) => {
        console.error('Post-game check error:', error.message);
      });
    }, Math.max(1, config.postGamePollMinutes) * 60_000);
  }
}

async function runOnce() {
  const dateYmd = dateInTimezone(config.timezone);
  const text = await buildAlert(dateYmd);

  if (config.telegramToken && config.telegramChatId) {
    const bot = new TelegramBot(config.telegramToken);
    await bot.sendMessage(config.telegramChatId, text);
    console.log(`Alert ${dateYmd} terkirim ke ${config.telegramChatId}.`);
  } else if (config.printAlertToTerminal) {
    console.log(text);
  } else {
    console.log(
      `Alert ${dateYmd} dibuat, tapi TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID belum lengkap. Terminal output hanya log.`
    );
  }
}

async function main() {
  if (process.argv.includes('--once')) {
    await runOnce();
    return;
  }

  await startDashboard({ enabled: config.dashboard.enabled }).catch((error) => {
    console.error(`Dashboard tidak bisa start: ${error.message}`);
  });

  const bot = new TelegramBot(config.telegramToken);
  await bot.setMyCommands(botCommandList()).catch((error) => {
    console.warn(`setMyCommands gagal/diabaikan: ${error.message}`);
  });
  configureLineMonitor({ bot, storage, config });
  configureLineupMonitor({
    bot,
    storage,
    config,
    onBothLineupsConfirmed: ({ chatId, game, awayLineup, homeLineup }) => sendBothLineupsPregameAlert(bot, chatId, game, awayLineup, homeLineup)
  });
  startScheduler(bot);

  if (config.telegramWebhook.enabled) {
    await startWebhookMode(bot);
    return;
  }

  await bot.deleteWebhook({ drop_pending_updates: false }).catch((error) => {
    console.warn(`deleteWebhook fallback polling gagal/diabaikan: ${error.message}`);
  });
  await poll(bot);
}

export { formatEvolveResult, parseJsonOutput, predictionsHaveRawProbabilities, isClosingCaptureEligible, shouldCaptureClosingNow, shouldTriggerCalibrationRetrain };

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const isPm2Run = process.env.NODE_APP_INSTANCE !== undefined;
if (isDirectRun || isPm2Run) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
