import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { ANALYST_SKILL_VERSION, buildAnalystSkillSummary } from './analystSkill.js';
import {
  analyzePredictionsWithAgent,
  answerInteractiveQuestion,
  summarizeDailyAlertWithOpenAI
} from './llm.js';
import {
  applyTotalRunMarket,
  formatPredictions,
  getFinalGameResults,
  getMlbPredictions,
  getMlbScheduleChoices
} from './mlb.js';
import { Storage } from './storage.js';
import { TelegramBot } from './telegram.js';
import { dateInTimezone, isValidDateYmd, percent, timeInTimezone } from './utils.js';
import { startDashboard } from './dashboard.js';

const config = loadConfig();
const storage = new Storage();
let postGameCheckRunning = false;
let autoUpdateCheckRunning = false;
const PREDICT_CALLBACK_PREFIX = 'predict_live:';
const LEGACY_PREDICT_CALLBACK_PREFIX = 'predict:';
const AGENT_TOOL_CALLBACK_PREFIX = 'agent_tool:';
const TOTAL_MARKET_BUTTONS = [6.5, 7.5, 8.5, 9.5, 10.5, 11.5];

function helpText() {
  return [
    'MLB Alert Bot siap.',
    '',
    'Command:',
    '/today - alert hari ini',
    '/deep - alert hari ini dengan advanced stats',
    '/date YYYY-MM-DD - alert tanggal tertentu',
    '/game TEAM - cek tim tertentu hari ini',
    '/predict - pilih game MLB dari tombol',
    '/agenttools - tools interaktif data/knowledge layer',
    '/kb pertanyaan - tanya knowledge base MLB',
    '/ask pertanyaan - tanya Analyst Agent',
    'Atau kirim pertanyaan biasa tanpa slash.',
    '/agent - lihat status Analyst Agent',
    '/skill - lihat playbook analisa Agent',
    '/postgame YYYY-MM-DD - cek recap final dan update memory',
    '/memory - lihat performa memory model',
    '/autoupdate on|off|time HH:mm|status - atur update otomatis',
    '/subscribe - aktifkan auto-alert di chat ini',
    '/unsubscribe - matikan auto-alert',
    '/sendalert - kirim alert hari ini ke subscriber',
    '/chatid - lihat chat id'
  ].join('\n');
}

function isAllowed(chatId) {
  if (config.allowedChatIds.length === 0) return true;
  return config.allowedChatIds.includes(String(chatId));
}

async function buildAlert(dateYmd, options = {}) {
  const modelMemory = config.modelMemory ? storage.getMemory() : {};
  const predictions = await getMlbPredictions(dateYmd, modelMemory);
  const includeAdvanced = options.includeAdvanced ?? config.alertDetail === 'full';

  await attachAgentAnalyses(predictions);
  storage.savePredictions(dateYmd, predictions);

  if (!options.teamFilter && !includeAdvanced && !config.analystAgent.enabled) {
    const llmText = await summarizeDailyAlertWithOpenAI(config, predictions).catch(() => null);
    if (llmText) return llmText;
  }

  return formatPredictions(dateYmd, predictions, {
    maxGames: config.maxGamesPerMessage,
    teamFilter: options.teamFilter || '',
    includeAdvanced
  });
}

async function attachAgentAnalyses(predictions) {
  const analyses = await analyzePredictionsWithAgent(
    config,
    predictions,
    storage.getMemorySummary()
  ).catch((error) => {
    console.error('Analyst Agent error:', error.message);
    return [];
  });

  const analysesByGame = new Map(analyses.map((analysis) => [analysis.gamePk, analysis]));
  for (const prediction of predictions) {
    const analysis = analysesByGame.get(prediction.gamePk) || null;
    prediction.agentAnalysis = analysis;
    if (analysis?.firstInning && prediction.firstInning) {
      prediction.firstInning.agent = analysis.firstInning;
    }
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

async function sendAlert(bot, chatId, dateYmd, options = {}) {
  await bot.sendMessage(chatId, `Mengambil data MLB ${dateYmd}...`);
  const text = await buildAlert(dateYmd, options);
  await bot.sendMessage(chatId, text);
  console.log(`Alert ${dateYmd} sent to ${chatId}.`);
}

function predictionHelpText() {
  return [
    'Kirim /predict untuk memilih game dari tombol.',
    '',
    'Format manual: /predict HOME | AWAY | odds_opsional',
    '',
    'Contoh:',
    '/predict',
    '/predict 2026-04-27',
    '/predict Los Angeles Dodgers | New York Yankees',
    '/predict Los Angeles Dodgers | New York Yankees | -120',
    '/predict Los Angeles Dodgers | New York Yankees | decimal 1.91',
    '',
    'Catatan: /predict tanpa matchup memakai schedule MLB live. Setelah game dipilih, tombol Total 6.5-11.5 bisa dipakai untuk cek market total. Format manual memakai Python ML engine dan sample CSV lokal.'
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

function totalMarketKeyboard(dateYmd, gamePk) {
  return {
    inline_keyboard: [
      TOTAL_MARKET_BUTTONS.slice(0, 3).map((line) => ({
        text: `Total ${line}`,
        callback_data: `${PREDICT_CALLBACK_PREFIX}${dateYmd}:${gamePk}:${line}`
      })),
      TOTAL_MARKET_BUTTONS.slice(3).map((line) => ({
        text: `Total ${line}`,
        callback_data: `${PREDICT_CALLBACK_PREFIX}${dateYmd}:${gamePk}:${line}`
      })),
      [
        {
          text: 'Refresh',
          callback_data: `${PREDICT_CALLBACK_PREFIX}${dateYmd}:${gamePk}`
        }
      ]
    ]
  };
}

async function sendPredictionGameMenu(bot, chatId, dateYmd = '') {
  const targetDate = dateYmd || dateInTimezone(config.timezone);
  const games = await getMlbScheduleChoices(targetDate);

  if (games.length === 0) {
    await bot.sendMessage(
      chatId,
      [
        `Tidak ada game MLB pada ${targetDate}.`,
        '',
        'Kamu tetap bisa pakai format manual:',
        '/predict Los Angeles Dodgers | New York Yankees'
      ].join('\n')
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    [
      '📊 Pilih game untuk MLB prediction:',
      `Tanggal: ${targetDate}`,
      `Sumber: MLB StatsAPI live schedule (${games.length} game)`,
      '',
      'Tap salah satu matchup di bawah.'
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

  const parts = payload
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) return null;

  const [home, away, rawOdds] = parts;
  let odds = '';
  let oddsFormat = 'american';

  if (rawOdds) {
    const decimalMatch = rawOdds.match(/^(decimal|dec)\s+(.+)$/i);
    if (decimalMatch) {
      oddsFormat = 'decimal';
      odds = decimalMatch[2].trim();
    } else {
      odds = rawOdds;
    }
  }

  return { home, away, odds, oddsFormat };
}

function runPythonPrediction({ home, away, odds, oddsFormat }) {
  return new Promise((resolve, reject) => {
    const args = ['-m', 'src.predict', '--home', home, '--away', away];
    if (odds) {
      args.push('--home-odds', odds, '--odds-format', oddsFormat);
    }

    const child = spawn(config.pythonExecutable, args, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Python prediction timeout. Coba lagi atau cek PYTHON_BIN.'));
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
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error((stderr || stdout || `Python exited with code ${code}`).trim()));
    });
  });
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

function formatPythonPredictionOutput(output) {
  return [
    '📊 MLB Python Prediction',
    '',
    output,
    '',
    '⚠️ Estimasi model, bukan jaminan hasil atau betting advice.'
  ].join('\n');
}

function agentToolHomeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Game Tools', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}games` },
        { text: 'Knowledge', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}knowledge` }
      ]
    ]
  };
}

function agentToolGamesKeyboard(games) {
  return {
    inline_keyboard: [
      ...games.map((game) => [
        {
          text: game.label,
          callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}game:${game.id}`
        }
      ]),
      [{ text: 'Knowledge', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}knowledge` }]
    ]
  };
}

function agentToolActionKeyboard(gameId) {
  return {
    inline_keyboard: [
      [
        { text: 'Moneyline', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}moneyline:${gameId}` },
        { text: 'Total', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}total:${gameId}` }
      ],
      [
        { text: 'Context', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}context:${gameId}` },
        { text: 'Full', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}full:${gameId}` }
      ],
      [{ text: 'Back to Games', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}games` }]
    ]
  };
}

function agentKnowledgeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'wRC+ vs OPS', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:wrc` },
        { text: 'FIP vs ERA', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:fip` }
      ],
      [
        { text: 'Wind & Over', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:wind` },
        { text: 'Bullpen Fatigue', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:bullpen` }
      ],
      [
        { text: 'Market Total', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:market` },
        { text: 'Value Bet', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:value` }
      ],
      [
        { text: 'Markets', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:markets` },
        { text: 'First 5', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:f5` }
      ],
      [{ text: 'Game Tools', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}games` }]
    ]
  };
}

async function sendAgentToolsMenu(bot, chatId) {
  await bot.sendMessage(
    chatId,
    ['MLB Agent Tools', '', 'Pilih action:'].join('\n'),
    { reply_markup: agentToolHomeKeyboard() }
  );
}

async function sendAgentToolGames(bot, chatId) {
  const payload = await runAgentBridge('games');
  await bot.sendMessage(chatId, payload.text || 'Pilih game:', {
    reply_markup: agentToolGamesKeyboard(payload.games || [])
  });
}

async function sendKnowledgeAnswer(bot, chatId, query) {
  const payload = await runAgentBridge('knowledge', [query]);
  await bot.sendMessage(chatId, payload.text || 'Knowledge tidak tersedia.', {
    reply_markup: agentKnowledgeKeyboard()
  });
}

function displayedPredictionProbabilities(prediction) {
  return {
    away: prediction.agentAnalysis?.awayProbability ?? Math.round(prediction.away.winProbability),
    home: prediction.agentAnalysis?.homeProbability ?? Math.round(prediction.home.winProbability)
  };
}

function predictionPick(prediction) {
  const agent = prediction.agentAnalysis;
  if (agent?.pickTeamId === prediction.away.id) return prediction.away;
  if (agent?.pickTeamId === prediction.home.id) return prediction.home;
  return prediction.winner;
}

function signedRuns(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '-';
  return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(1)}`;
}

function sumNumberValues(...values) {
  return values.reduce((sum, value) => {
    const parsed = Number(value);
    return sum + (Number.isFinite(parsed) ? parsed : 0);
  }, 0);
}

function totalProbabilityLines(label, probabilities) {
  return TOTAL_MARKET_BUTTONS.map(
    (line) => `• ${label} ${line}: ${percent(probabilities[String(line)] || 0)}`
  );
}

function totalDriverLines(totalDetail) {
  return [
    `• Offense: ${signedRuns(sumNumberValues(totalDetail.homeOffense, totalDetail.awayOffense))}`,
    `• Starting pitcher: ${signedRuns(sumNumberValues(totalDetail.homeStarterAllowed, totalDetail.awayStarterAllowed))}`,
    `• Bullpen: ${signedRuns(sumNumberValues(totalDetail.homeBullpenAllowed, totalDetail.awayBullpenAllowed))}`,
    `• Weather: ${signedRuns(totalDetail.weather)}`,
    `• Lineup: ${signedRuns(sumNumberValues(totalDetail.homeLineupAdj, totalDetail.awayLineupAdj))}`
  ];
}

function lineupContextLines(lineupLine) {
  const lines = String(lineupLine || '')
    .split(' | ')
    .filter(Boolean);

  return lines.length ? lines.map((line) => `• ${line}`) : ['• Lineup: belum tersedia'];
}

function formatLivePrediction(dateYmd, prediction, options = {}) {
  const probabilities = displayedPredictionProbabilities(prediction);
  const pick = predictionPick(prediction);
  const agentActive = Boolean(prediction.agentAnalysis);
  const reasons = agentActive ? prediction.agentAnalysis.reasons : prediction.reasons;
  const confidence = agentActive ? prediction.agentAnalysis.confidence : 'model';
  const pickProbability =
    pick.id === prediction.away.id ? probabilities.away : probabilities.home;
  const opponent = pick.id === prediction.away.id ? prediction.home : prediction.away;
  const opponentProbability =
    pick.id === prediction.away.id ? probabilities.home : probabilities.away;
  const firstInning = prediction.firstInning;
  const firstPick = firstInning?.agent?.pick || firstInning?.baselinePick || 'NO';
  const firstProbability = firstInning?.agent?.probability ?? firstInning?.baselineProbability ?? 50;
  const firstLabel = firstPick === 'YES' ? 'YES / YRFI' : 'NO / NRFI';
  const injuryLines = prediction.injuryDetailLines?.length
    ? prediction.injuryDetailLines.map((line) => `• ${line}`)
    : [`• ${prediction.injuryLine || 'Data injury tidak tersedia.'}`];
  const modelReferenceLines = prediction.modelReferenceLines?.length
    ? prediction.modelReferenceLines.map((line) => `• ${line}`)
    : [`• ${prediction.modelReferenceLine}`];
  const totalRuns = applyTotalRunMarket(prediction.totalRuns, options.marketLine);
  const totalDetail = totalRuns?.detail || {};
  const totalRunLines = totalRuns
    ? [
        '📌 Projection',
        `• Projected total: ${totalRuns.projectedTotal.toFixed(1)} runs`,
        `• Expected runs: ${prediction.away.abbreviation || prediction.away.name} ${totalRuns.awayExpectedRuns.toFixed(1)} | ${prediction.home.abbreviation || prediction.home.name} ${totalRuns.homeExpectedRuns.toFixed(1)}`,
        `• Market total: ${totalRuns.marketLine} (${signedRuns(totalRuns.marketDeltaRuns)} runs vs model)`,
        `• Best lean: ${totalRuns.bestLean} (${totalRuns.confidence})`,
        `• Model edge: ${signedRuns(totalRuns.modelEdge)}% vs 50% baseline`,
        '',
        '📈 Over Probability',
        ...totalProbabilityLines('Over', totalRuns.over),
        '',
        '📉 Under Probability',
        ...totalProbabilityLines('Under', totalRuns.under),
        '',
        '⚙️ Run Drivers',
        ...totalDriverLines(totalDetail),
        '',
        '🏟 Context',
        `• Park: ${totalRuns.detail?.park?.label || prediction.venue} (Run PF ${totalRuns.detail?.park?.runFactorPct || 100}, HR PF ${totalRuns.detail?.park?.homeRunFactorPct || 100})`,
        ...lineupContextLines(prediction.lineupLine),
        '',
        '🧾 Main Factors',
        ...totalRuns.factors.slice(0, 4).map((factor) => `• ${factor}`)
      ]
    : ['Data total runs tidak tersedia.'];

  return [
    '📊 MLB Prediction',
    `📅 ${dateYmd}`,
    '',
    `🏟️ ${prediction.away.name} @ ${prediction.home.name}`,
    `🕒 ${prediction.start}`,
    `📍 ${prediction.venue}`,
    '',
    '────────────',
    '🏆 Hasil Predict',
    `Predicted Winner: ${pick.name}`,
    `Win Probability: ${percent(pickProbability)}`,
    `Opponent: ${opponent.name} ${percent(opponentProbability)}`,
    `Confidence: ${confidence}`,
    `Source: ${agentActive ? 'Analyst Agent + live MLB stats' : 'Baseline model + live MLB stats'}`,
    '',
    '────────────',
    '📊 Probabilitas Detail',
    `${prediction.away.abbreviation || prediction.away.name}: ${percent(probabilities.away)} | ${prediction.home.abbreviation || prediction.home.name}: ${percent(probabilities.home)}`,
    agentActive
      ? `Baseline: ${prediction.away.abbreviation || prediction.away.name} ${percent(prediction.away.winProbability)} | ${prediction.home.abbreviation || prediction.home.name} ${percent(prediction.home.winProbability)}`
      : null,
    '',
    '────────────',
    '🔥 Starting Pitcher',
    `${prediction.away.starterLine} vs ${prediction.home.starterLine}`,
    '',
    '🏥 Injury Report',
    ...injuryLines,
    '',
    '🧠 ML Reference',
    ...modelReferenceLines,
    '',
    'First Inning',
    `Will there be a run in the 1st? ${firstLabel} ${percent(firstProbability)}`,
    '',
    '🏃 Total Runs / Over-Under',
    ...totalRunLines,
    '',
    'Alasan:',
    ...reasons.slice(0, 3).map((reason) => `• ${reason}`),
    agentActive ? `Risk: ${prediction.agentAnalysis.risk}` : null,
    '',
    '⚠️ Estimasi model, bukan jaminan hasil atau betting advice.'
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n');
}

async function sendPythonPrediction(bot, chatId, text) {
  const request = parsePredictCommand(text);
  if (!request) {
    await bot.sendMessage(chatId, predictionHelpText());
    return;
  }

  if (request.menu) {
    await bot.sendMessage(
      chatId,
      `Mengambil semua game MLB ${request.dateYmd || dateInTimezone(config.timezone)}...`
    );
    await sendPredictionGameMenu(bot, chatId, request.dateYmd);
    return;
  }

  await bot.sendMessage(chatId, `Menjalankan Python prediction: ${request.away} @ ${request.home}...`);
  const output = await runPythonPrediction(request);
  await bot.sendMessage(chatId, formatPythonPredictionOutput(output));
  console.log(`Python prediction handled for ${chatId}: ${request.away} @ ${request.home}.`);
}

async function handlePredictCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const data = callbackQuery.data || '';
  const [dateYmd, rawGamePk, rawMarketLine] = data.slice(PREDICT_CALLBACK_PREFIX.length).split(':');
  const gamePk = Number.parseInt(rawGamePk, 10);
  const marketLine = rawMarketLine ? Number.parseFloat(rawMarketLine) : undefined;

  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Mengambil prediksi...' }).catch(() => {});

  if (!chatId) return;
  if (!isValidDateYmd(dateYmd) || !Number.isFinite(gamePk) || (rawMarketLine && !Number.isFinite(marketLine))) {
    await bot.sendMessage(chatId, 'Data tombol tidak valid. Coba kirim /predict lagi untuk refresh daftar.');
    return;
  }

  await bot.sendMessage(chatId, `Menganalisa game MLB ${dateYmd}...`);
  const modelMemory = config.modelMemory ? storage.getMemory() : {};
  const predictions = await getMlbPredictions(dateYmd, modelMemory);
  const prediction = predictions.find((item) => item.gamePk === gamePk);

  if (!prediction) {
    await bot.sendMessage(chatId, 'Game tidak ditemukan. Coba kirim /predict lagi untuk refresh daftar.');
    return;
  }

  await attachAgentAnalyses([prediction]);
  storage.savePredictions(dateYmd, [prediction]);
  await bot.sendMessage(chatId, formatLivePrediction(dateYmd, prediction, { marketLine }), {
    reply_markup: totalMarketKeyboard(dateYmd, gamePk)
  });
  console.log(
    `Live prediction callback handled for ${chatId}: ${prediction.away.name} @ ${prediction.home.name}.`
  );
}

async function handleAgentToolCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const data = callbackQuery.data || '';
  const [action, value = ''] = data.slice(AGENT_TOOL_CALLBACK_PREFIX.length).split(':');

  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Loading...' }).catch(() => {});
  if (!chatId) return;

  if (action === 'games') {
    await sendAgentToolGames(bot, chatId);
    return;
  }

  if (action === 'knowledge') {
    await bot.sendMessage(chatId, 'Pilih topik knowledge:', {
      reply_markup: agentKnowledgeKeyboard()
    });
    return;
  }

  if (action === 'kb') {
    await sendKnowledgeAnswer(bot, chatId, value || 'wrc');
    return;
  }

  if (action === 'game') {
    const payload = await runAgentBridge('game', [value]);
    await bot.sendMessage(chatId, payload.text || 'Game tidak tersedia.', {
      reply_markup: agentToolActionKeyboard(value)
    });
    return;
  }

  if (['moneyline', 'total', 'context', 'full'].includes(action)) {
    const payload = await runAgentBridge(action, [value]);
    await bot.sendMessage(chatId, payload.text || 'Output tidak tersedia.', {
      reply_markup: agentToolActionKeyboard(value)
    });
    return;
  }

  await bot.sendMessage(chatId, 'Action tidak dikenal. Coba /agenttools lagi.');
}

async function sendAlertToAll(bot, dateYmd) {
  const chatIds = targetChatIds();

  if (chatIds.length === 0) {
    return 0;
  }

  const text = await buildAlert(dateYmd);
  for (const chatId of chatIds) {
    await bot.sendMessage(chatId, text).catch((error) => {
      console.error(`Gagal kirim ke ${chatId}:`, error.message);
    });
  }

  return chatIds.length;
}

function formatMemorySummary() {
  const summary = storage.getMemorySummary();
  const confidenceLines = Object.entries(summary.byConfidence || {})
    .map(([key, value]) => {
      const accuracy = value.total > 0 ? Math.round((value.correct / value.total) * 100) : 0;
      return `${key}: ${value.correct}/${value.total} (${accuracy}%)`;
    })
    .join('\n');
  const matchupMemory = summary.matchupMemory || { totalMatchups: 0, recent: [] };
  const matchupLines = (matchupMemory.recent || [])
    .map((item) => `- ${item.note}`)
    .join('\n');

  return [
    '🧠 MLB Model Memory',
    '',
    `Total pick: ${summary.totalPicks}`,
    `Benar: ${summary.correctPicks}`,
    `Salah: ${summary.wrongPicks}`,
    `Akurasi: ${summary.accuracy}%`,
    '',
    'Confidence:',
    confidenceLines || 'Belum ada data confidence.',
    '',
    'First Inning:',
    `Total: ${summary.firstInning.totalPicks}`,
    `Benar: ${summary.firstInning.correctPicks}`,
    `Salah: ${summary.firstInning.wrongPicks}`,
    `Akurasi: ${summary.firstInning.accuracy}%`,
    `YES: ${summary.firstInning.byPick.YES.correct}/${summary.firstInning.byPick.YES.total}`,
    `NO: ${summary.firstInning.byPick.NO.correct}/${summary.firstInning.byPick.NO.total}`,
    '',
    'Matchup memory:',
    `Tracked matchups: ${matchupMemory.totalMatchups}`,
    matchupLines || 'Belum ada matchup berulang yang tersimpan.',
    '',
    'Recent learning:',
    summary.recentLog.length
      ? summary.recentLog.map((item) => `${item.correct ? '✅' : '❌'} ${item.note}`).join('\n')
      : 'Belum ada post-game learning.'
  ].join('\n');
}

function formatAgentStatus() {
  const summary = storage.getMemorySummary();

  return [
    '🤖 MLB Analyst Agent',
    '',
    `Status: ${config.analystAgent.enabled ? 'aktif' : 'mati'}`,
    `Mode: ${config.analystAgent.mode}`,
    `Skill: ${ANALYST_SKILL_VERSION}`,
    `Model: ${config.openai.model}`,
    `Memory: ${config.modelMemory ? 'aktif' : 'mati'}`,
    `Interactive chat: ${config.interactiveAgent ? 'aktif' : 'mati'}`,
    `Post-game learning: ${config.postGameAlerts ? 'aktif' : 'mati'}`,
    'Tools: /agenttools atau /kb',
    '',
    `Memory sample: ${summary.totalPicks} pick, akurasi ${summary.accuracy}%`,
    '',
    config.analystAgent.enabled
      ? 'Agent membuat pick final dari stats, H2H, baseline model, dan memory.'
      : 'Agent mati, bot memakai baseline model statistik.'
  ].join('\n');
}

function autoUpdateHelpText() {
  return [
    'Format auto update:',
    '',
    '/autoupdate on - aktifkan update harian untuk chat ini',
    '/autoupdate off - matikan update harian',
    '/autoupdate time HH:mm - ubah jam update',
    '/autoupdate status - lihat status',
    '',
    `Timezone: ${config.timezone}`,
    `Default time: ${config.dailyAlertTime}`
  ].join('\n');
}

function formatAutoUpdateStatus(chatId) {
  const status = storage.getAutoUpdate(chatId);
  return [
    '🔔 Auto Update MLB',
    '',
    `Status: ${status.enabled ? 'aktif' : 'mati'}`,
    `Jam update: ${status.dailyTime || config.dailyAlertTime}`,
    `Timezone: ${config.timezone}`,
    `Terakhir terkirim: ${status.lastSentDate || '-'}`,
    '',
    'Command:',
    '/autoupdate on',
    '/autoupdate off',
    '/autoupdate time 20:00'
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
      await bot.sendMessage(chatId, 'Format jam salah. Contoh: /autoupdate time 20:00');
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

async function askAgent(bot, chatId, question, dateYmd = dateInTimezone(config.timezone)) {
  if (!question.trim()) {
    await bot.sendMessage(
      chatId,
      [
        'Format: /ask pertanyaan',
        '',
        'Contoh:',
        '/ask game mana yang edge-nya paling kuat hari ini?',
        '/ask kenapa Yankees dipilih?',
        '/ask upset risk terbesar hari ini?'
      ].join('\n')
    );
    return;
  }

  await bot.sendMessage(chatId, `🤖 Analyst Agent membaca slate MLB ${dateYmd}...`);
  const predictions = await getMlbPredictions(dateYmd, config.modelMemory ? storage.getMemory() : {});
  await attachAgentAnalyses(predictions);
  storage.savePredictions(dateYmd, predictions);

  const answer = await answerInteractiveQuestion(config, {
    question,
    dateYmd,
    predictions,
    memorySummary: storage.getMemorySummary()
  }).catch((error) => {
    console.error('Interactive Agent error:', error.message);
    return null;
  });

  await bot.sendMessage(
    chatId,
    answer ||
      'Agent belum bisa menjawab sekarang. Coba cek /today dulu atau pastikan OPENAI_API_KEY dan ANALYST_AGENT aktif.'
  );
  console.log(`Interactive question handled for ${chatId}.`);
}

async function evaluatePostGames(dateYmd, { markProcessed = true, includeProcessed = false } = {}) {
  const results = await getFinalGameResults(dateYmd);
  const evaluations = [];

  for (const result of results) {
    const prediction = storage.getPrediction(result.gamePk);
    if (!prediction) continue;
    if (prediction.postGameProcessed && markProcessed && !includeProcessed) continue;

    const correct = prediction.pick.id === result.winner.id;
    const learned = markProcessed && !prediction.postGameProcessed;

    evaluations.push({
      prediction,
      result,
      correct,
      learned
    });

    if (learned) {
      storage.recordOutcome(prediction, result, { enabled: config.modelMemory });
    }
  }

  return evaluations;
}

function formatPostGameRecap(dateYmd, evaluations) {
  if (evaluations.length === 0) {
    return [
      '🏁 MLB Post-game Recap',
      `📅 ${dateYmd}`,
      '',
      'Belum ada game final dengan pick pre-game yang tersimpan.',
      'Pastikan /today, /deep, atau auto-alert sudah jalan sebelum game dimulai.'
    ].join('\n');
  }

  const correctCount = evaluations.filter((item) => item.correct).length;
  const separator = '━━━━━━━━━━━━━━━━━━━━';
  const lines = [
    '🏁 MLB Post-game Recap',
    `📅 ${dateYmd}`,
    `🎯 Akurasi pick: ${correctCount}/${evaluations.length}`,
    '',
    separator
  ];

  for (const item of evaluations) {
    const { prediction, result, correct, learned } = item;
    const scoreLine = `${result.away.abbreviation || result.away.name} ${result.away.score} - ${result.home.score} ${result.home.abbreviation || result.home.name}`;
    const firstInningActual =
      result.firstInning?.anyRun === null ? 'unavailable' : result.firstInning.anyRun ? 'YES' : 'NO';
    const firstInningCorrect =
      prediction.firstInning && result.firstInning?.anyRun !== null
        ? prediction.firstInning.pick === firstInningActual
        : null;
    const memoryLine = learned
      ? correct
        ? 'Memory: pick benar; matchup pattern disimpan sebagai sinyal kecil.'
        : `Memory: pick salah disimpan; matchup pattern mencatat ${result.winner.abbreviation || result.winner.name} menang tanpa auto-bias berlebihan.`
      : 'Memory: game ini sudah pernah diproses.';

    lines.push(
      [
        `🏟️ ${prediction.matchup}`,
        `📍 Final: ${scoreLine}`,
        `🏆 Winner: ${result.winner.name}`,
        `🎯 Pick: ${prediction.pick.name} (${prediction.pick.winProbability}%)`,
        `${correct ? '✅ Benar' : '❌ Salah'}`,
        prediction.firstInning
          ? `🏁 1st inning: pick ${prediction.firstInning.pick} (${prediction.firstInning.probability}%), actual ${firstInningActual}${firstInningCorrect === null ? '' : firstInningCorrect ? ' ✅' : ' ❌'}`
          : null,
        `🧠 ${memoryLine}`
      ].filter(Boolean).join('\n')
    );
    lines.push(separator);
  }

  lines.push('⚠️ Memory adalah adjustment kecil, bukan jaminan hasil berikutnya.');
  return lines.join('\n\n');
}

async function handleMessage(bot, message) {
  const chat = message.chat;
  const chatId = chat.id;
  const text = message.text?.trim() || '';
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand?.replace(/@.+$/, '').toLowerCase();

  if (command === '/chatid') {
    await bot.sendMessage(chatId, `Chat ID: ${chatId}`);
    return;
  }

  if (!isAllowed(chatId)) {
    await bot.sendMessage(chatId, 'Chat ini belum diizinkan. Tambahkan ID ini ke ALLOWED_CHAT_IDS.');
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
    await bot.sendMessage(chatId, 'Auto-alert dimatikan untuk chat ini.');
    return;
  }

  if (command === '/today') {
    const maybeDate = args[0];
    const dateYmd = isValidDateYmd(maybeDate) ? maybeDate : dateInTimezone(config.timezone);
    await sendAlert(bot, chatId, dateYmd);
    return;
  }

  if (command === '/deep') {
    const maybeDate = args[0];
    const dateYmd = isValidDateYmd(maybeDate) ? maybeDate : dateInTimezone(config.timezone);
    await sendAlert(bot, chatId, dateYmd, { includeAdvanced: true });
    return;
  }

  if (command === '/date') {
    const dateYmd = args[0];
    if (!isValidDateYmd(dateYmd)) {
      await bot.sendMessage(chatId, 'Format: /date YYYY-MM-DD');
      return;
    }

    await sendAlert(bot, chatId, dateYmd);
    return;
  }

  if (command === '/game') {
    const teamFilter = args.join(' ').trim();
    if (!teamFilter) {
      await bot.sendMessage(chatId, 'Format: /game Yankees atau /game LAD');
      return;
    }

    await sendAlert(bot, chatId, dateInTimezone(config.timezone), { teamFilter });
    return;
  }

  if (command === '/predict') {
    await sendPythonPrediction(bot, chatId, text);
    return;
  }

  if (command === '/agenttools' || command === '/tools') {
    await sendAgentToolsMenu(bot, chatId);
    return;
  }

  if (command === '/kb' || command === '/knowledge') {
    const query = args.join(' ').trim();
    if (!query) {
      await bot.sendMessage(chatId, 'Pilih topik knowledge:', {
        reply_markup: agentKnowledgeKeyboard()
      });
      return;
    }
    await sendKnowledgeAnswer(bot, chatId, query);
    return;
  }

  if (command === '/ask') {
    await askAgent(bot, chatId, args.join(' '));
    return;
  }

  if (command === '/autoupdate') {
    await handleAutoUpdateCommand(bot, chat, args);
    return;
  }

  if (command === '/sendalert') {
    const dateYmd = dateInTimezone(config.timezone);
    const sent = await sendAlertToAll(bot, dateYmd);
    await bot.sendMessage(chatId, sent > 0 ? `Alert terkirim ke ${sent} chat.` : 'Belum ada subscriber/chat id target.');
    return;
  }

  if (command === '/postgame') {
    const maybeDate = args[0];
    const dateYmd = isValidDateYmd(maybeDate) ? maybeDate : dateInTimezone(config.timezone);
    await bot.sendMessage(chatId, `Mengecek final game MLB ${dateYmd}...`);
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

  if (text && !text.startsWith('/') && config.interactiveAgent) {
    await askAgent(bot, chatId, text);
    return;
  }

  await bot.sendMessage(chatId, helpText());
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

  if (data.startsWith(AGENT_TOOL_CALLBACK_PREFIX)) {
    await handleAgentToolCallback(bot, callbackQuery);
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

async function poll(bot) {
  let offset = storage.getLastUpdateId() ? storage.getLastUpdateId() + 1 : undefined;
  console.log('Telegram bot polling aktif.');

  while (true) {
    try {
      const updates = await bot.getUpdates({ offset, timeout: 30 });
      for (const update of updates) {
        offset = update.update_id + 1;
        storage.setLastUpdateId(update.update_id);

        if (update.message) {
          await handleMessage(bot, update.message).catch(async (error) => {
            console.error(error);
            await bot.sendMessage(update.message.chat.id, `Error: ${error.message}`).catch(() => {});
          });
        }

        if (update.callback_query) {
          await handleCallbackQuery(bot, update.callback_query).catch(async (error) => {
            console.error(error);
            const chatId = update.callback_query.message?.chat?.id;
            if (chatId) {
              await bot.sendMessage(chatId, `Error: ${error.message}`).catch(() => {});
            }
          });
        }
      }
    } catch (error) {
      console.error('Polling error:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function processPendingPostGames(bot) {
  if (postGameCheckRunning) return;
  if (targetChatIds().length === 0) return;

  postGameCheckRunning = true;
  try {
    for (const dateYmd of storage.listPendingPredictionDates()) {
      const evaluations = await evaluatePostGames(dateYmd, { markProcessed: true });
      if (evaluations.length === 0) continue;

      const text = formatPostGameRecap(dateYmd, evaluations);
      const sent = await sendTextToAll(bot, text);
      console.log(`Post-game recap ${dateYmd} terkirim ke ${sent} chat.`);
    }
  } finally {
    postGameCheckRunning = false;
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
    const text = await buildAlert(today);
    for (const target of targets) {
      await bot
        .sendMessage(target.chatId, text)
        .then(() => {
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

function startScheduler(bot) {
  processAutoUpdates(bot).catch((error) => {
    console.error('Auto-update check error:', error.message);
  });

  setInterval(() => {
    processAutoUpdates(bot).catch((error) => {
      console.error('Auto-update check error:', error.message);
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
  startScheduler(bot);
  await poll(bot);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
