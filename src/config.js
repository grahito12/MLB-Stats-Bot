import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const equalsIndex = trimmed.indexOf('=');
  if (equalsIndex === -1) return null;

  const key = trimmed.slice(0, equalsIndex).trim();
  let value = trimmed.slice(equalsIndex + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return [key, value];
}

export function loadDotEnv(filePath = resolve(process.cwd(), '.env')) {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;

    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function csv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function intFromEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberFromEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveIntFromEnv(value, fallback) {
  const parsed = intFromEnv(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

export function loadConfig() {
  loadDotEnv();

  return {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    allowedChatIds: csv(process.env.ALLOWED_CHAT_IDS),
    telegramWebhook: {
      enabled: boolFromEnv(process.env.TELEGRAM_WEBHOOK_MODE, false),
      url: process.env.TELEGRAM_WEBHOOK_URL || '',
      port: intFromEnv(process.env.TELEGRAM_WEBHOOK_PORT, 8443),
      secret: process.env.TELEGRAM_WEBHOOK_SECRET || ''
    },
    timezone: process.env.TIMEZONE || 'Asia/Jakarta',
    autoAlerts: boolFromEnv(process.env.AUTO_ALERTS, false),
    dailyAlertTime: process.env.DAILY_ALERT_TIME || '20:00',
    postGameAlerts: boolFromEnv(process.env.POST_GAME_ALERTS, true),
    postGamePollMinutes: intFromEnv(process.env.POST_GAME_POLL_MINUTES, 5),
    modelMemory: boolFromEnv(process.env.MODEL_MEMORY, true),
    // Phase 2 (2026-08): raised 0.04 → 0.05. Selection-only; does not change model probs.
    minimumMoneylineEdge: numberFromEnv(process.env.MINIMUM_MONEYLINE_EDGE, 0.05),
    moneylineOddsMaxAgeMinutes: numberFromEnv(process.env.MONEYLINE_ODDS_MAX_AGE_MINUTES, 10),
    // Rolling avg CLV gate for new VALUE bets (ledger selection quality).
    clvGate: {
      enabled: boolFromEnv(process.env.CLV_GATE_ENABLED, true),
      minSample: intFromEnv(process.env.CLV_GATE_MIN_SAMPLE, 20),
      minAvgClv: numberFromEnv(process.env.CLV_GATE_MIN_AVG, 0),
      lookback: intFromEnv(process.env.CLV_GATE_LOOKBACK, 50)
    },
    // Market-anchored residual probability for VALUE grading only. 0 disables
    // blending; positive values borrow a small amount of no-vig market signal
    // while keeping the model's own pick/winner intact.
    moneylineMarketResidualWeight: numberFromEnv(process.env.MONEYLINE_MARKET_RESIDUAL_WEIGHT, 0),
    news: {
      enabled: boolFromEnv(process.env.NEWS_ENABLED, false),
      feeds: process.env.NEWS_FEEDS_JSON || '',
      timeoutMs: positiveIntFromEnv(process.env.NEWS_REQUEST_TIMEOUT_MS, 8000),
      cacheTtlMs: positiveIntFromEnv(process.env.NEWS_CACHE_TTL_MINUTES, 15) * 60 * 1000,
      staleIfErrorMs: positiveIntFromEnv(process.env.NEWS_STALE_IF_ERROR_HOURS, 12) * 60 * 60 * 1000,
      maxResponseBytes: positiveIntFromEnv(process.env.NEWS_MAX_RESPONSE_BYTES, 1000000),
      maxItems: positiveIntFromEnv(process.env.NEWS_MAX_ITEMS_PER_FEED, 25),
      maxArticlesPerGame: positiveIntFromEnv(process.env.NEWS_MAX_ARTICLES_PER_GAME, 5),
      maxTitleChars: positiveIntFromEnv(process.env.NEWS_MAX_TITLE_CHARS, 240),
      maxSummaryChars: positiveIntFromEnv(process.env.NEWS_MAX_SUMMARY_CHARS, 600),
      maxAgeHours: positiveIntFromEnv(process.env.NEWS_MAX_AGE_HOURS, 48),
      includePicks: boolFromEnv(process.env.NEWS_INCLUDE_PICKS, false),
      includeAlerts: boolFromEnv(process.env.NEWS_INCLUDE_ALERTS, false),
      // When true (default), keyword risk flags may force VALUE → NO BET only.
      // News never changes model probability, edge math, or stake sizing.
      riskVeto: boolFromEnv(process.env.NEWS_RISK_VETO, true)
    },
    interactiveAgent: boolFromEnv(process.env.INTERACTIVE_AGENT, true),
    printAlertToTerminal: boolFromEnv(process.env.PRINT_ALERT_TO_TERMINAL, false),
    maxGamesPerMessage: intFromEnv(process.env.MAX_GAMES_PER_MESSAGE, 8),
    pythonExecutable: process.env.PYTHON_BIN || 'python3',
    dashboard: {
      enabled: boolFromEnv(process.env.DASHBOARD_ENABLED, true),
      host: process.env.DASHBOARD_HOST || '0.0.0.0',
      port: intFromEnv(process.env.DASHBOARD_PORT, 3008)
    },
    lineMonitor: {
      enabled: boolFromEnv(process.env.LINE_MOVEMENT_ALERTS, true),
      intervalMinutes: intFromEnv(process.env.LINE_MONITOR_INTERVAL_MINUTES, 10),
      moneylineThreshold: numberFromEnv(process.env.LINE_MOVEMENT_THRESHOLD_ML, 15),
      totalThreshold: numberFromEnv(process.env.LINE_MOVEMENT_THRESHOLD_TOTAL, 0.5),
      oddsApiKey: process.env.ODDS_API_KEY || process.env.THE_ODDS_API_KEY || ''
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL || '',
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      useSummary: boolFromEnv(process.env.USE_OPENAI_SUMMARY, false)
    },
    analystAgent: {
      enabled: boolFromEnv(process.env.ANALYST_AGENT, false),
      mode: process.env.ANALYST_AGENT_MODE || 'local',
      url: process.env.ANALYST_AGENT_URL || '',
      apiKey: process.env.ANALYST_AGENT_API_KEY || '',
      timeoutMs: intFromEnv(process.env.ANALYST_AGENT_TIMEOUT_MS, 45000)
    },
    alertDetail: process.env.ALERT_DETAIL === 'full' ? 'full' : 'compact'
  };
}
