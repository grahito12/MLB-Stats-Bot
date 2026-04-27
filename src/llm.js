import { clamp, toNumber } from './utils.js';
import {
  ANALYST_INTERACTIVE_PROMPT,
  ANALYST_SKILL_VERSION,
  ANALYST_SYSTEM_PROMPT
} from './analystSkill.js';

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function llmBaseUrl(config) {
  if (config.openai.baseUrl) return trimSlash(config.openai.baseUrl);

  const keyLooksLikeGateway = config.openai.apiKey.startsWith('sk-or-');
  const modelLooksLikeGateway = config.openai.model.includes('/');
  if (keyLooksLikeGateway || modelLooksLikeGateway) {
    return 'https://openrouter.ai/api/v1';
  }

  return 'https://api.openai.com/v1';
}

function useChatCompletions(config) {
  const baseUrl = llmBaseUrl(config);
  return baseUrl !== 'https://api.openai.com/v1' || config.openai.model.includes('/');
}

function extractJson(text) {
  if (!text) return null;

  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

async function callLlm(config, { system, user, maxTokens = 900, timeoutMs = 45000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const baseUrl = llmBaseUrl(config);

  try {
    if (useChatCompletions(config)) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openai.apiKey}`
        },
        body: JSON.stringify({
          model: config.openai.model,
          temperature: 0.2,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        })
      });

      if (!response.ok) return null;
      const data = await response.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    }

    const response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openai.apiKey}`
      },
      body: JSON.stringify({
        model: config.openai.model,
        store: false,
        temperature: 0.2,
        max_output_tokens: maxTokens,
        instructions: system,
        input: user
      })
    });

    if (!response.ok) return null;
    const data = await response.json();
    if (data.output_text) return data.output_text.trim();

    return (
      data.output
        ?.flatMap((item) => item.content || [])
        ?.filter((item) => item.type === 'output_text' && item.text)
        ?.map((item) => item.text)
        ?.join('\n')
        ?.trim() || null
    );
  } finally {
    clearTimeout(timer);
  }
}

function compactGameForAgent(item) {
  return {
    gamePk: item.gamePk,
    matchup: `${item.away.name} @ ${item.home.name}`,
    start: item.start,
    venue: item.venue,
    away: {
      id: item.away.id,
      name: item.away.name,
      abbreviation: item.away.abbreviation,
      baselineProbability: Math.round(item.away.winProbability)
    },
    home: {
      id: item.home.id,
      name: item.home.name,
      abbreviation: item.home.abbreviation,
      baselineProbability: Math.round(item.home.winProbability)
    },
    baselinePick: item.winner.name,
    headToHead: {
      games: item.headToHead?.games || 0,
      awayWins: item.headToHead?.awayWins || 0,
      homeWins: item.headToHead?.homeWins || 0,
      awayProbability: Math.round(item.headToHead?.awayProbability || 50),
      homeProbability: Math.round(item.headToHead?.homeProbability || 50)
    },
    starters: {
      away: item.away.starterLine,
      home: item.home.starterLine
    },
    context: item.contextLine,
    matchupSplits: item.matchupSplitLine,
    bullpen: item.bullpenLine,
    bullpenDetail: item.bullpen,
    pitcherRecent: item.pitcherRecentLine,
    pitcherRecentDetail: item.pitcherRecent,
    advanced: item.advancedLine,
    modelReference: item.modelReference,
    modelReferenceLine: item.modelReferenceLine,
    baselineReasons: item.reasons,
    firstInning: item.firstInning
      ? {
          baselinePick: item.firstInning.baselinePick,
          baselineProbability: Math.round(item.firstInning.baselineProbability),
          topRate: Math.round(item.firstInning.topRate),
          bottomRate: Math.round(item.firstInning.bottomRate),
          h2h: item.firstInning.h2h,
          awayProfileLine: item.firstInning.awayProfileLine,
          homeProfileLine: item.firstInning.homeProfileLine,
          baselineReasons: item.firstInning.reasons
        }
      : null,
    memoryAdjustment: item.memoryAdjustment,
    agentAnalysis: item.agentAnalysis
      ? {
          pickTeamName: item.agentAnalysis.pickTeamName,
          awayProbability: item.agentAnalysis.awayProbability,
          homeProbability: item.agentAnalysis.homeProbability,
          confidence: item.agentAnalysis.confidence,
          reasons: item.agentAnalysis.reasons,
          risk: item.agentAnalysis.risk,
          memoryNote: item.agentAnalysis.memoryNote
        }
      : null
  };
}

function normalizeProbability(value, fallback) {
  return clamp(Math.round(toNumber(value, fallback)), 20, 80);
}

function resolveTeamId(value, prediction) {
  const numeric = Number(value);
  if (numeric === prediction.away.id || numeric === prediction.home.id) return numeric;

  const text = String(value || '').toLowerCase();
  if (!text) return null;

  const awayTokens = [prediction.away.name, prediction.away.abbreviation]
    .filter(Boolean)
    .map((item) => item.toLowerCase());
  const homeTokens = [prediction.home.name, prediction.home.abbreviation]
    .filter(Boolean)
    .map((item) => item.toLowerCase());

  if (awayTokens.some((token) => text === token || text.includes(token))) return prediction.away.id;
  if (homeTokens.some((token) => text === token || text.includes(token))) return prediction.home.id;

  return null;
}

function probabilityFromObject(raw, prediction, side) {
  const team = side === 'away' ? prediction.away : prediction.home;
  const containers = [
    raw?.probability,
    raw?.probabilities,
    raw?.winProbability,
    raw?.winProbabilities,
    raw?.agentProbability,
    raw?.agentProbabilities
  ].filter(Boolean);

  for (const container of containers) {
    const value =
      container[side] ??
      container[team.name] ??
      container[team.abbreviation] ??
      container[team.id] ??
      container[String(team.id)];

    if (value !== undefined) return value;
  }

  return undefined;
}

function normalizeYesNo(value, fallback = 'NO') {
  const text = String(value || fallback).toLowerCase();
  if (['yes', 'yrfi', 'y', 'run', 'ada', 'over'].some((token) => text.includes(token))) {
    return 'YES';
  }
  if (['no', 'nrfi', 'n', 'tidak', 'under'].some((token) => text.includes(token))) {
    return 'NO';
  }
  return fallback;
}

function sanitizeFirstInningAnalysis(prediction, raw) {
  const source =
    raw?.firstInning ??
    raw?.first_inning ??
    raw?.yrfiNrfi ??
    raw?.yrfi_nrfi ??
    raw?.firstInningRun ??
    null;

  const baseline = prediction.firstInning || {};
  if (!source || typeof source !== 'object') {
    return {
      pick: baseline.baselinePick || 'NO',
      probability: Math.round(baseline.baselineProbability || 50),
      confidence: baseline.confidence || 'low',
      reasons: baseline.reasons || []
    };
  }

  const pick = normalizeYesNo(
    source.pick ?? source.verdict ?? source.answer ?? source.willThereBeRun,
    baseline.baselinePick || 'NO'
  );
  const probability = clamp(
    Math.round(toNumber(source.probability ?? source.yrfiProbability ?? source.runProbability, baseline.baselineProbability || 50)),
    20,
    80
  );
  const reasons = Array.isArray(source.reasons)
    ? source.reasons.map((item) => String(item).trim()).filter(Boolean).slice(0, 3)
    : baseline.reasons || [];

  return {
    pick,
    probability,
    confidence: ['low', 'medium', 'high'].includes(source.confidence)
      ? source.confidence
      : baseline.confidence || 'low',
    reasons,
    risk: String(source.risk || '').slice(0, 180)
  };
}

function sanitizeAnalysis(prediction, raw) {
  const awayId = prediction.away.id;
  const homeId = prediction.home.id;
  const pickTeamId = resolveTeamId(
    raw?.pickTeamId ?? raw?.pick_team_id ?? raw?.pick ?? raw?.winner ?? raw?.pickTeam ?? raw?.pickTeamName,
    prediction
  );
  if (pickTeamId !== awayId && pickTeamId !== homeId) return null;

  let awayProbability = normalizeProbability(
    raw?.awayProbability ?? raw?.away_probability ?? probabilityFromObject(raw, prediction, 'away'),
    prediction.away.winProbability
  );
  let homeProbability = normalizeProbability(
    raw?.homeProbability ?? raw?.home_probability ?? probabilityFromObject(raw, prediction, 'home'),
    prediction.home.winProbability
  );
  const total = awayProbability + homeProbability;

  if (total > 0 && total !== 100) {
    awayProbability = Math.round((awayProbability / total) * 100);
    homeProbability = 100 - awayProbability;
  }

  if (pickTeamId === awayId && awayProbability <= homeProbability) {
    awayProbability = 55;
    homeProbability = 45;
  }

  if (pickTeamId === homeId && homeProbability <= awayProbability) {
    homeProbability = 55;
    awayProbability = 45;
  }

  const reasons = Array.isArray(raw?.reasons)
    ? raw.reasons.map((item) => String(item).trim()).filter(Boolean).slice(0, 3)
    : [];

  return {
    gamePk: prediction.gamePk,
    pickTeamId,
    pickTeamName: pickTeamId === awayId ? prediction.away.name : prediction.home.name,
    awayProbability,
    homeProbability,
    confidence: ['low', 'medium', 'high'].includes(raw?.confidence) ? raw.confidence : 'medium',
    reasons: reasons.length > 0 ? reasons : prediction.reasons.slice(0, 3),
    risk: String(raw?.risk || 'Tidak ada risk khusus yang dominan.').slice(0, 220),
    memoryNote: String(raw?.memoryNote || 'Memory dipakai sebagai sinyal kecil.').slice(0, 220),
    firstInning: sanitizeFirstInningAnalysis(prediction, raw),
    source: 'analyst-agent'
  };
}

function sanitizeAnalyses(predictions, rawAnalyses) {
  if (!Array.isArray(rawAnalyses)) return [];

  const byGamePk = new Map(predictions.map((item) => [item.gamePk, item]));
  const analyses = [];

  for (const raw of rawAnalyses) {
    const gamePk = Number(raw?.gamePk);
    const prediction = byGamePk.get(gamePk);
    if (!prediction) continue;

    const sanitized = sanitizeAnalysis(prediction, raw);
    if (sanitized) analyses.push(sanitized);
  }

  return analyses;
}

function findAnalysisArray(value, depth = 0) {
  if (!value || depth > 5) return null;

  if (Array.isArray(value)) {
    return value.some((item) => item && typeof item === 'object' && item.gamePk !== undefined)
      ? value
      : null;
  }

  if (typeof value !== 'object') return null;

  for (const child of Object.values(value)) {
    const found = findAnalysisArray(child, depth + 1);
    if (found) return found;
  }

  return null;
}

function normalizeInteractiveAnswer(text) {
  if (!text) return null;

  const trimmed = String(text).trim();
  const parsed = extractJson(trimmed);
  if (!parsed) return trimmed;

  if (typeof parsed.answer === 'string') return parsed.answer.trim();
  if (typeof parsed.text === 'string') return parsed.text.trim();
  if (typeof parsed.message === 'string') return parsed.message.trim();

  const lines = [];
  if (parsed.bestGame) lines.push(`Pilihan terkuat: ${parsed.bestGame}`);
  if (parsed.edge) lines.push(`Edge: ${parsed.edge}`);
  if (Array.isArray(parsed.reasons) && parsed.reasons.length > 0) {
    lines.push('Alasan:');
    lines.push(...parsed.reasons.slice(0, 3).map((reason) => `• ${reason}`));
  }
  if (parsed.risk) lines.push(`Risk: ${parsed.risk}`);

  return lines.length > 0 ? lines.join('\n') : trimmed;
}

async function analyzeWithExternalAgent(config, predictions, memorySummary) {
  if (!config.analystAgent.url) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.analystAgent.timeoutMs);

  try {
    const response = await fetch(config.analystAgent.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.analystAgent.apiKey
          ? { Authorization: `Bearer ${config.analystAgent.apiKey}` }
          : {})
      },
      body: JSON.stringify({
        task: 'mlb_pre_game_analysis',
        skillVersion: ANALYST_SKILL_VERSION,
        analystPlaybook: ANALYST_SYSTEM_PROMPT,
        memory: memorySummary,
        games: predictions.map(compactGameForAgent),
        outputContract: {
          analyses:
            'Array of { gamePk, pickTeamId, awayProbability, homeProbability, confidence, reasons, risk, memoryNote, firstInning: { pick: YES|NO, probability, confidence, reasons, risk } }'
        }
      })
    });

    if (!response.ok) return [];
    const data = await response.json();
    return sanitizeAnalyses(predictions, findAnalysisArray(data));
  } finally {
    clearTimeout(timer);
  }
}

async function analyzeWithLocalAgent(config, predictions, memorySummary) {
  if (!config.openai.apiKey) return [];

  const user = JSON.stringify({
    skillVersion: ANALYST_SKILL_VERSION,
    memory: memorySummary,
    games: predictions.map(compactGameForAgent),
    outputContract: {
      analyses: [
        {
          gamePk: 'number',
          pickTeamId: 'number, must be away.id or home.id',
          awayProbability: 'integer',
          homeProbability: 'integer',
          confidence: 'low | medium | high',
          reasons: ['2-3 alasan singkat bahasa Indonesia'],
          risk: 'risiko terbesar pick ini',
          memoryNote: 'bagaimana memory mempengaruhi analisa, atau netral',
          firstInning: {
            required: true,
            pick: 'YES jika kemungkinan ada run di inning pertama, NO jika condong NRFI',
            probability: 'integer 20-80',
            confidence: 'low | medium | high',
            reasons: ['2-3 alasan singkat dari riwayat first inning, starter, H2H'],
            risk: 'risiko terbesar untuk verdict first inning'
          }
        }
      ]
    }
  });

  const text = await callLlm(config, {
    system: ANALYST_SYSTEM_PROMPT,
    user,
    maxTokens: Math.min(4500, 700 + predictions.length * 360),
    timeoutMs: config.analystAgent.timeoutMs
  });

  const parsed = extractJson(text);
  return sanitizeAnalyses(predictions, findAnalysisArray(parsed));
}

export async function analyzePredictionsWithAgent(config, predictions, memorySummary) {
  if (!config.analystAgent.enabled || predictions.length === 0) return [];

  if (config.analystAgent.mode === 'external') {
    return analyzeWithExternalAgent(config, predictions, memorySummary);
  }

  return analyzeWithLocalAgent(config, predictions, memorySummary);
}

async function askExternalAgent(config, { question, dateYmd, predictions, memorySummary }) {
  if (!config.analystAgent.url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.analystAgent.timeoutMs);

  try {
    const response = await fetch(config.analystAgent.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.analystAgent.apiKey
          ? { Authorization: `Bearer ${config.analystAgent.apiKey}` }
          : {})
      },
      body: JSON.stringify({
        task: 'mlb_interactive_question',
        skillVersion: ANALYST_SKILL_VERSION,
        analystPlaybook: ANALYST_SYSTEM_PROMPT,
        dateYmd,
        question,
        memory: memorySummary,
        games: predictions.map(compactGameForAgent),
        outputContract: {
          answer: 'Telegram-ready Indonesian answer, concise, based only on provided data.'
        }
      })
    });

    if (!response.ok) return null;
    const data = await response.json();
    return normalizeInteractiveAnswer(data.answer || data.text || data.message || JSON.stringify(data));
  } finally {
    clearTimeout(timer);
  }
}

async function askLocalAgent(config, { question, dateYmd, predictions, memorySummary }) {
  if (!config.openai.apiKey) return null;

  const text = await callLlm(config, {
    system: ANALYST_INTERACTIVE_PROMPT,
    user: JSON.stringify({
      dateYmd,
      question,
      memory: memorySummary,
      games: predictions.map(compactGameForAgent)
    }),
    maxTokens: 1000,
    timeoutMs: config.analystAgent.timeoutMs
  });

  return normalizeInteractiveAnswer(text);
}

export async function answerInteractiveQuestion(config, payload) {
  if (!config.interactiveAgent) return null;

  if (config.analystAgent.mode === 'external') {
    return askExternalAgent(config, payload);
  }

  return askLocalAgent(config, payload);
}

export async function summarizeDailyAlertWithOpenAI(config, predictions) {
  if (!config.openai.apiKey || !config.openai.useSummary || predictions.length === 0) {
    return null;
  }

  const compactGames = predictions.map((item) => ({
    matchup: `${item.away.name} @ ${item.home.name}`,
    start: item.start,
    venue: item.venue,
    probability: {
      [item.away.name]: `${Math.round(item.away.winProbability)}%`,
      [item.home.name]: `${Math.round(item.home.winProbability)}%`
    },
    winner: item.winner.name,
    head_to_head: {
      games: item.headToHead?.games || 0,
      record: `${item.away.name} ${item.headToHead?.awayWins || 0}-${item.headToHead?.homeWins || 0} ${item.home.name}`,
      probability: {
        [item.away.name]: `${Math.round(item.headToHead?.awayProbability || 50)}%`,
        [item.home.name]: `${Math.round(item.headToHead?.homeProbability || 50)}%`
      }
    },
    context: item.contextLine,
    advanced: item.advancedLine,
    reasons: item.reasons
  }));

  const text = await callLlm(config, {
    system:
      'Kamu membuat alert MLB bahasa Indonesia. Gunakan hanya data yang diberikan. Output harus pendek, jelas, tanpa klaim betting pasti.',
    user:
      'Buat alert Telegram ringkas dengan emoji baseball. Untuk setiap game tulis matchup, probabilitas model, probabilitas H2H, pemenang model, context terpenting, dan 2 alasan paling kuat.\n\n' +
      JSON.stringify(compactGames),
    maxTokens: 900
  });

  return text?.trim() || null;
}
