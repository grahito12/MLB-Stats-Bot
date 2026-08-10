import {
  clamp,
  dateInTimezone,
  formatGameTime,
  percent,
  safeFixed,
  sigmoid,
  toNumber
} from './utils.js';
import { UI_LINE, UI_THIN_LINE, uiBullet, uiKV, uiSection, uiTitle } from './telegramFormat.js';
import { getEvolutionRule, loadEvolutionControls, moneylineWeightMultiplier } from './evolutionControls.js';
import { calibratePercent, hasCalibrationMap } from './calibration.js';
import { loadConfig } from './config.js';
import { evaluateMoneyline } from './rule_engine.js';
import {
  ageMinutes as temporalAgeMinutes,
  checkDataFreshness,
  filterSplitsBeforeDate
} from './temporal_contract.js';
import { predictGameMoneylineCore, buildCoreInputsSnapshot, PREDICTION_CORE_MODEL_VERSION } from './core/prediction_core.js';
import { marketAnchoredProbabilities } from './market_residual.js';
import { attachPickConfidence, buildPickConfidence } from './confidence_signals.js';

const MLB_BASE_URL = 'https://statsapi.mlb.com/api/v1';
const _mlbConfig = loadConfig();
const MLB_TIMEZONE = _mlbConfig.timezone;
const GAME_SEPARATOR = UI_LINE;
const SECTION_SEPARATOR = UI_THIN_LINE;
// Defaults mirror config.minimumMoneylineEdge (percent scale). Live path reads config.
const DEFAULT_MONEYLINE_VALUE_EDGE_THRESHOLD = 5.0;
// Soft secondary gates (thin matchup / incomplete lineup) still use 4.0 unless
// rules JSON params override — edge floor itself is the configurable hard gate.
const STRONG_VALUE_EDGE_THRESHOLD = 4.0;
// Calibrated win-probability floor for a graded VALUE bet. Deep analysis of
// 1105 moneyline outcomes (2026 run) showed the model is OVERCONFIDENT at high probs:
//   50-55% predicted → ~56% actual (underconfident ← BEST bucket)
//   55-60% predicted → ~53% actual (overconfident)
//   65-70% predicted → ~51% actual (overconfident)
// Floor stays at 52% so VALUE can land in the better-calibrated band.
// Historical VALUE WR still lags (~49%) — selection gates + real-form signals
// must carry the lift, not a higher conviction floor.
const MIN_VALUE_PROBABILITY = 52.0;
// Team quality gate: team must have >= this season win% to qualify for VALUE.
// Picks on teams with .520+ WR: 70.2% historical accuracy.
// Picks on sub-.500 teams: 35.2% accuracy. Market prices them correctly.
const MIN_TEAM_QUALITY_PCT = 0.520;
// Away underdog limit: block VALUE bets on away teams at plus-money odds
// beyond this threshold. Away underdogs are the model's worst leak:
// AWAY+VALUE = 44.9% WR. This kills the away longshot trap.
const MAX_AWAY_UNDERDOG_ODDS = 115;
// Rolling team form window (MLB StatsAPI byDateRange). Season stats lag true
// current strength; 21 calendar days ≈ 18-19 games and is leakage-safe when
// endDate is predictionDate-1.
const ROLLING_FORM_DAYS = 21;
// Bayesian market blend weight. Market de-vig implied is the strongest single
// pre-game predictor; pure model alone plateaus ~55%. Raise from 12% → 22% so
// displayed pick/winner incorporates real market information without letting
// the book fully overwrite model edge (VALUE still grades pure model).
const MARKET_BLEND_WEIGHT = 0.22;
const OPENER_KEYWORD_RE = /\b(opener|bulk|piggyback)\b|opener\s*\/\s*bulk/i;
const OPENER_NOTE_KEYS = new Set([
  'note',
  'notes',
  'description',
  'summary',
  'role',
  'type',
  'gameNote',
  'gameNotes',
  'probablePitcherNote',
  'probablePitcherNotes'
]);
const PARK_FACTOR_BASELINES = new Map([
  [108, { runFactor: 1.0, homeRunFactor: 1.02, label: 'Angel Stadium' }],
  [109, { runFactor: 1.0, homeRunFactor: 1.02, label: 'Chase Field' }],
  [110, { runFactor: 0.96, homeRunFactor: 0.94, label: 'Camden Yards' }],
  [111, { runFactor: 1.06, homeRunFactor: 0.98, label: 'Fenway Park' }],
  [112, { runFactor: 1.01, homeRunFactor: 1.04, label: 'Wrigley Field' }],
  [113, { runFactor: 1.04, homeRunFactor: 1.14, label: 'Great American Ball Park' }],
  [114, { runFactor: 0.98, homeRunFactor: 0.97, label: 'Progressive Field' }],
  [115, { runFactor: 1.15, homeRunFactor: 1.12, label: 'Coors Field' }],
  [116, { runFactor: 0.98, homeRunFactor: 0.96, label: 'Comerica Park' }],
  [117, { runFactor: 0.99, homeRunFactor: 1.01, label: 'Daikin Park' }],
  [118, { runFactor: 1.02, homeRunFactor: 0.96, label: 'Kauffman Stadium' }],
  [119, { runFactor: 0.99, homeRunFactor: 1.02, label: 'Dodger Stadium' }],
  [120, { runFactor: 1.0, homeRunFactor: 1.0, label: 'Nationals Park' }],
  [121, { runFactor: 0.97, homeRunFactor: 0.98, label: 'Citi Field' }],
  [133, { runFactor: 0.98, homeRunFactor: 0.98, label: 'Athletics home park' }],
  [134, { runFactor: 0.99, homeRunFactor: 0.94, label: 'PNC Park' }],
  [135, { runFactor: 0.96, homeRunFactor: 0.96, label: 'Petco Park' }],
  [136, { runFactor: 0.94, homeRunFactor: 0.95, label: 'T-Mobile Park' }],
  [137, { runFactor: 0.94, homeRunFactor: 0.9, label: 'Oracle Park' }],
  [138, { runFactor: 0.98, homeRunFactor: 0.97, label: 'Busch Stadium' }],
  [139, { runFactor: 0.98, homeRunFactor: 0.99, label: 'Tropicana Field' }],
  [140, { runFactor: 1.02, homeRunFactor: 1.04, label: 'Globe Life Field' }],
  [141, { runFactor: 1.0, homeRunFactor: 1.03, label: 'Rogers Centre' }],
  [142, { runFactor: 0.99, homeRunFactor: 1.0, label: 'Target Field' }],
  [143, { runFactor: 1.03, homeRunFactor: 1.08, label: 'Citizens Bank Park' }],
  [144, { runFactor: 1.01, homeRunFactor: 1.04, label: 'Truist Park' }],
  [145, { runFactor: 1.01, homeRunFactor: 1.05, label: 'Rate Field' }],
  [146, { runFactor: 0.95, homeRunFactor: 0.93, label: 'loanDepot park' }],
  [147, { runFactor: 1.01, homeRunFactor: 1.08, label: 'Yankee Stadium' }],
  [158, { runFactor: 0.99, homeRunFactor: 1.02, label: 'American Family Field' }]
]);
const DEFAULTS = {
  rpg: 4.4,
  ops: 0.72,
  era: 4.2,
  whip: 1.3,
  winPct: 0.5,
  iso: 0.15,
  kRate: 0.22,
  bbRate: 0.085,
  kMinusBb: 0.12,
  hr9: 1.1
};

// --- Situational Weight Adjustment ---
const BASE_WEIGHTS = {
  offense: 0.30,
  starting_pitcher: 0.38,
  bullpen: 0.90,
  recent_form: 0.28,
  home_advantage: 1.0
};
const MAX_WEIGHT_SHIFT = 0.15;

function situationalWeightAdjustment(venueId, openerDetected, gameDateYmd) {
  const parkInfo = PARK_FACTOR_BASELINES.get(venueId);
  const runFactor = parkInfo ? parkInfo.runFactor : 1.0;
  const parkType = runFactor >= 1.05 ? 'hitter_park' : runFactor <= 0.95 ? 'pitcher_park' : 'neutral';
  const month = gameDateYmd ? parseInt(gameDateYmd.slice(5, 7), 10) : 6;
  const phase = month <= 4 ? 'early' : month >= 8 ? 'late' : 'mid';

  const adj = { offense: 0, starting_pitcher: 0, bullpen: 0, recent_form: 0, home_advantage: 0 };

  if (parkType === 'hitter_park') { adj.offense += 0.08; adj.starting_pitcher -= 0.05; }
  else if (parkType === 'pitcher_park') { adj.starting_pitcher += 0.08; adj.offense -= 0.05; }

  if (openerDetected) { adj.starting_pitcher -= 0.12; adj.bullpen += 0.15; }

  if (phase === 'early') { adj.recent_form -= 0.10; adj.starting_pitcher += 0.03; }
  else if (phase === 'late') { adj.recent_form += 0.08; adj.bullpen += 0.05; }

  const multipliers = {};
  for (const key of Object.keys(BASE_WEIGHTS)) {
    const shift = clamp(adj[key] || 0, -MAX_WEIGHT_SHIFT, MAX_WEIGHT_SHIFT);
    multipliers[key] = 1.0 + shift;
  }
  return multipliers;
}

// --- Sharp Money Detection ---
export function detectSharpMoneySignal(modelPick, openingOdds, closingOdds) {
  if (!openingOdds || !closingOdds) return { direction: 'neutral', magnitude: 0, steam: false, risk: 0 };
  const opening = toNumber(openingOdds[modelPick], 0);
  const closing = toNumber(closingOdds[modelPick], 0);
  if (!opening || !closing) return { direction: 'neutral', magnitude: 0, steam: false, risk: 0 };

  const movement = closing - opening;
  const magnitude = Math.abs(movement);
  const direction = magnitude < 3 ? 'neutral' : movement < 0 ? 'toward_model' : 'against_model';
  const steam = magnitude >= 20;

  let risk = 0;
  if (direction === 'against_model') risk += Math.min(magnitude * 0.015, 0.30);
  if (steam && direction === 'against_model') risk += 0.20;
  if (direction === 'toward_model') risk -= Math.min(magnitude * 0.008, 0.15);

  return { direction, magnitude, steam, risk: clamp(risk, 0, 1) };
}

// --- Prediction Tier ---
function determinePredictionTier(gameStartTime, now = new Date()) {
  if (!gameStartTime) return { tier: 'standard', label: 'Standard', confidenceCap: 85 };
  const current = now instanceof Date ? now : new Date(now);
  const start = new Date(gameStartTime);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(current.getTime())) {
    return { tier: 'standard', label: 'Standard', confidenceCap: 85 };
  }
  const hoursToGame = (start - current) / 3600000;
  // Already started / in-play: do not treat as final pregame tier.
  if (hoursToGame < 0) {
    return { tier: 'in_play', label: 'In Play', confidenceCap: 0, reject: true };
  }
  if (hoursToGame >= 6) return { tier: 'early_preview', label: 'Early Preview', confidenceCap: 60 };
  if (hoursToGame >= 2) return { tier: 'standard', label: 'Standard', confidenceCap: 85 };
  return { tier: 'final', label: 'Final Prediction', confidenceCap: 95 };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'mlb-alert-telegram-agent/0.1'
      }
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function seasonFromDate(dateYmd) {
  return Number.parseInt(dateYmd.slice(0, 4), 10);
}

function seasonStartDate(season) {
  return `${season}-03-01`;
}

function shiftYmd(dateYmd, dayDelta) {
  const date = new Date(`${dateYmd}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateYmd;
  date.setUTCDate(date.getUTCDate() + dayDelta);
  return date.toISOString().slice(0, 10);
}

function rollingFormWindow(dateYmd, days = ROLLING_FORM_DAYS) {
  const endDate = shiftYmd(dateYmd, -1);
  const startDate = shiftYmd(endDate, -(Math.max(1, days) - 1));
  return { startDate, endDate };
}

function teamMemoryBias(modelMemory, teamId) {
  return clamp(toNumber(modelMemory?.teamBias?.[String(teamId)], 0), -0.08, 0.08);
}

function sortTeamIds(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right));
}

function matchupMemoryKey(teamAId, teamBId) {
  return [String(teamAId), String(teamBId)].sort(sortTeamIds).join(':');
}

function safeTeamLabel(team) {
  return team?.abbreviation || team?.name || 'team';
}

function buildMatchupMemoryContext(modelMemory, awayTeam, homeTeam) {
  const key = matchupMemoryKey(awayTeam.id, homeTeam.id);
  const entry = modelMemory?.matchupMemory?.[key];
  if (!entry) {
    return {
      key,
      games: 0,
      edge: 0,
      note: 'Belum ada matchup memory tersimpan.',
      recentGames: []
    };
  }

  const recentGames = (entry.recentGames || []).slice(0, 5);
  const weights = [0.03, 0.022, 0.015, 0.01, 0.006];
  let sequenceEdge = 0;
  let missedEdge = 0;

  recentGames.forEach((game, index) => {
    const weight = weights[index] || 0.004;
    const winnerId = String(game.winner?.id || '');
    if (winnerId === String(homeTeam.id)) sequenceEdge += weight;
    if (winnerId === String(awayTeam.id)) sequenceEdge -= weight;

    if (game.correct === false) {
      if (winnerId === String(homeTeam.id)) missedEdge += weight * 0.5;
      if (winnerId === String(awayTeam.id)) missedEdge -= weight * 0.5;
    }
  });

  let edge = sequenceEdge + clamp(missedEdge, -0.03, 0.03);
  const averageMargin = toNumber(entry.averageMargin, 0);
  const alternating = Boolean(entry.alternating);
  const streakLength = Number(entry.currentStreak?.length || 0);

  if (alternating) edge *= 0.45;
  if (averageMargin > 0 && averageMargin <= 1.5) edge *= 0.6;
  if (streakLength >= 3) edge *= 0.8;

  const finalEdge = clamp(edge, -0.08, 0.08);
  const edgeTeam =
    finalEdge > 0.01 ? safeTeamLabel(homeTeam) : finalEdge < -0.01 ? safeTeamLabel(awayTeam) : 'netral';
  const note =
    entry.note ||
    (recentGames.length
      ? `Matchup memory ${recentGames.length} game recent, edge kecil ke ${edgeTeam}.`
      : 'Belum ada matchup memory tersimpan.');

  return {
    key,
    games: entry.totalGames || recentGames.length,
    edge: finalEdge,
    edgeTeam,
    note,
    currentStreak: entry.currentStreak || null,
    alternating,
    averageMargin,
    pickStats: entry.pickStats || { total: 0, correct: 0 },
    recentGames: recentGames.map((game) => ({
      dateYmd: game.dateYmd,
      winner: game.winner,
      loser: game.loser,
      margin: game.margin,
      correct: game.correct
    }))
  };
}

function leagueRecordPct(record) {
  if (!record) return DEFAULTS.winPct;
  if (record.pct !== undefined) return toNumber(record.pct, DEFAULTS.winPct);

  const wins = toNumber(record.wins, 0);
  const losses = toNumber(record.losses, 0);
  const total = wins + losses;
  return total > 0 ? wins / total : DEFAULTS.winPct;
}

function recordText(record) {
  if (!record) return '-';

  const wins = record.wins ?? 0;
  const losses = record.losses ?? 0;
  return `${wins}-${losses}`;
}

function winProbText(team) {
  return `${team.abbreviation || team.name} ${percent(team.winProbability)}`;
}

function displayedProbabilities(item) {
  return {
    away: item.away.winProbability,
    home: item.home.winProbability
  };
}

function agentPick(item) {
  return item.winner;
}

function displayedWinProbText(team, value) {
  return `${team.abbreviation || team.name} ${percent(value)}`;
}

function h2hProbText(team, probability) {
  return `${team.abbreviation || team.name} ${percent(probability)}`;
}

function openerAlertLines(item) {
  return [item.away, item.home]
    .filter((team) => team?.openerSituation?.isOpener)
    .map((team) => {
      const pitcherName = team.starter?.fullName || team.starter?.name || 'Listed pitcher';
      return uiKV('⚠️', 'Opener situation', `${pitcherName} may not be the primary pitcher`);
    });
}

function lateUpdateWarnings(item, { compact = false } = {}) {
  const warnings = [];
  const hasOpener = [item.away, item.home].some((team) => team?.openerSituation?.isOpener);
  const missingStarter = [item.away, item.home].some((team) => {
    const name = team?.starter?.fullName || team?.starter?.name || team?.starterLine || '';
    return !name || String(name).toLowerCase().includes('tbd');
  });
  if (hasOpener) warnings.push('opener/bulk pitcher');
  if (missingStarter) warnings.push('probable pitcher TBD');

  if (!compact) {
    const lineups = [item.lineups?.away, item.lineups?.home].filter(Boolean);
    const incompleteLineup =
      lineups.length < 2 || lineups.some((lineup) => !lineup.confirmed || toNumber(lineup.count, 0) < 9);
    if (incompleteLineup) warnings.push('lineup belum confirmed');
    if (!item.currentOdds?.awayMoneyline || !item.currentOdds?.homeMoneyline) warnings.push('moneyline odds belum lengkap');
  }

  return [...new Set(warnings)].slice(0, compact ? 2 : 5);
}

function lateUpdateLines(item, options = {}) {
  const warnings = lateUpdateWarnings(item, options);
  return warnings.length ? [uiKV('⚠️', 'Late Watch', warnings.join(' | '))] : [];
}

export function formatMoneylineOdds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed === 0) return '-';
  return parsed > 0 ? `+${parsed}` : String(parsed);
}

function americanImpliedProbabilityPercent(value) {
  const odds = Number(value);
  if (!Number.isFinite(odds) || odds === 0) return null;
  const probabilityValue = odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
  return probabilityValue * 100;
}

// Two-sided de-vig for a SAME-BOOK paired market only. Independently shopped
// best-home and best-away from different books can produce a synthetic pair
// with negative overround; that must not be treated as a fair market.
function devigMoneylinePercent(awayOdds, homeOdds, options = {}) {
  const awayImplied = americanImpliedProbabilityPercent(awayOdds);
  const homeImplied = americanImpliedProbabilityPercent(homeOdds);
  if (awayImplied === null || homeImplied === null) return null;
  const total = awayImplied + homeImplied;
  if (!Number.isFinite(total) || total <= 0) return null;
  const overround = total - 100;
  const sameBook = options.sameBook !== false;
  // Cross-book synthetic pairs: allow only if overround is non-negative and
  // caller explicitly marks sameBook=false as executable-only (no fair claim).
  if (!sameBook) {
    return {
      away: null,
      home: null,
      overround: round1(overround),
      sameBook: false,
      synthetic: true,
      usableAsFair: false
    };
  }
  if (overround < -0.05) {
    // Negative overround on an alleged same-book pair is not a coherent market.
    return {
      away: null,
      home: null,
      overround: round1(overround),
      sameBook: true,
      synthetic: false,
      usableAsFair: false
    };
  }
  return {
    away: (awayImplied / total) * 100,
    home: (homeImplied / total) * 100,
    overround: round1(overround),
    sameBook: true,
    synthetic: false,
    usableAsFair: true
  };
}

function moneylineBooksAreSame(currentOdds) {
  if (!currentOdds) return false;
  const homeSide = currentOdds.homeMoneylineBook || null;
  const awaySide = currentOdds.awayMoneylineBook || null;
  // Explicit side books: only same-book when both present and equal.
  if (homeSide && awaySide) {
    return String(homeSide).toLowerCase() === String(awaySide).toLowerCase();
  }
  // Conflicting partial provenance (one side shopped, other unknown) → not same-book.
  if (homeSide || awaySide) {
    // Single shared moneylineBook may still represent a paired book if no conflict.
    // If only one side book is known and matches moneylineBook, treat as same-book;
    // if it differs from moneylineBook, refuse fair de-vig.
    const generic = currentOdds.moneylineBook || null;
    if (!generic) return false;
    const known = homeSide || awaySide;
    return String(known).toLowerCase() === String(generic).toLowerCase();
  }
  // Legacy payload: only moneylineBook set (tests + older snapshots) → same-book pair.
  return Boolean(currentOdds.moneylineBook);
}

function round1(value) {
  return Math.round(toNumber(value, 0) * 10) / 10;
}

// American odds → net profit multiple per 1 unit staked (b in the Kelly formula).
// -150 → 0.667 (risk 1 to win 0.667); +130 → 1.30.
function americanProfitMultiple(value) {
  const odds = Number(value);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
}

// Quarter-Kelly stake as a % of bankroll, computed from the pure CALIBRATED
// model probability (not winProbabilityRaw and not market-informed display odds)
// and the offered American odds. Calibration deliberately compresses model
// overconfidence; sizing off raw conviction would re-inflate the edge and
// oversize bets. Quarter-Kelly (fraction 0.25) matches the bot's
// risk_management.py default. Returns null when there is no positive-EV stake.
const KELLY_FRACTION = 0.25;
function quarterKellyPercent(modelProbabilityPercent, odds) {
  const b = americanProfitMultiple(odds);
  if (b === null) return null;
  const p = toNumber(modelProbabilityPercent, 0) / 100;
  if (!(p > 0) || p >= 1) return null;
  const q = 1 - p;
  const fullKelly = (b * p - q) / b;
  if (!(fullKelly > 0)) return null;
  return round1(fullKelly * KELLY_FRACTION * 100);
}

function pureModelProbabilityForSide(item, side) {
  const team = side === 'away' ? item.away : item.home;
  const breakdownProbability = side === 'away'
    ? item.modelBreakdown?.pureAwayProbability
    : item.modelBreakdown?.pureHomeProbability;
  return toNumber(team?.pureModelProbability ?? breakdownProbability ?? team?.winProbability, 50);
}

function moneylineValueOption(item, side) {
  const odds = side === 'away' ? item.currentOdds?.awayMoneyline : item.currentOdds?.homeMoneyline;
  const impliedProbability = americanImpliedProbabilityPercent(odds);
  if (!Number.isFinite(Number(odds)) || impliedProbability === null) return null;

  const team = side === 'away' ? item.away : item.home;
  let modelProbability = pureModelProbabilityForSide(item, side);

  // Fair de-vig only when both sides share the same bookmaker. Best executable
  // side price may still come from line shopping (side-specific book).
  const sameBook = moneylineBooksAreSame(item.currentOdds);
  const devig = devigMoneylinePercent(
    item.currentOdds?.awayMoneyline,
    item.currentOdds?.homeMoneyline,
    { sameBook }
  );
  const fairFromDevig =
    devig?.usableAsFair && devig[side] != null ? (side === 'away' ? devig.away : devig.home) : null;
  const fairProbability = fairFromDevig != null ? fairFromDevig : impliedProbability;

  // Market-anchored residual: when explicitly enabled, grading probability
  // borrows a small amount of no-vig market signal. The model's own pick and
  // displayed win probabilities stay untouched; this only changes VALUE
  // probability/edge math so sizing/edge are less miscalibrated.
  const anchored = marketAnchoredProbabilities({
    modelHomeProbability: pureModelProbabilityForSide(item, 'home'),
    modelAwayProbability: pureModelProbabilityForSide(item, 'away'),
    homeMoneyline: item.currentOdds?.homeMoneyline,
    awayMoneyline: item.currentOdds?.awayMoneyline
  });
  const gradingProbability = anchored ? (side === 'away' ? anchored.away : anchored.home) : modelProbability;
  const edge = gradingProbability - fairProbability;

  // Disagreement sizing boost: when model picks away but market favors home
  // (the validated asymmetric edge), bump the Kelly stake by a validated factor.
  // Walk-forward validated: model-away vs market-home shows 81-97% WR.
  const modelHomeProb = pureModelProbabilityForSide(item, 'home');
  const modelAwayProb = 100 - modelHomeProb;
  const marketHomeProb = toNumber(fairProbability, 50);
  const marketAwayProb = 100 - marketHomeProb;
  const isDisagreement = modelAwayProb > modelHomeProb && marketHomeProb > marketAwayProb;
  const disagreementBoost = isDisagreement && side === 'away' ? 1.5 : 1.0;

  const sideBook =
    side === 'away'
      ? item.currentOdds?.awayMoneylineBook || item.currentOdds?.moneylineBook
      : item.currentOdds?.homeMoneylineBook || item.currentOdds?.moneylineBook;

  // Multi-factor confidence (SP/form/H2H/injury/lineup) adjusts stake after
  // disagreement boost. Elite factors up to 1.25x; weak factors down to 0.75x.
  const factorConfidence = buildPickConfidence(item, side);
  const confidenceMultiplier = factorConfidence?.stakeMultiplier ?? 1.0;

  const baseKelly = edge > 0 ? quarterKellyPercent(gradingProbability, odds) : null;
  const kellyStakePercent =
    baseKelly !== null ? round1(baseKelly * disagreementBoost * confidenceMultiplier) : null;

  return {
    side,
    teamId: team?.id,
    teamName: team?.name,
    teamAbbreviation: team?.abbreviation,
    odds,
    book: sideBook || 'market',
    modelProbability: round1(modelProbability),
    gradingProbability: round1(gradingProbability),
    marketResidualWeight: anchored ? anchored.weight : 0,
    impliedProbability: round1(impliedProbability),
    fairProbability: round1(fairProbability),
    fairSource: fairFromDevig != null ? 'same_book_devig' : 'raw_implied_executable',
    sameBookDevig: Boolean(fairFromDevig != null),
    overround: devig ? round1(devig.overround) : null,
    edge: round1(edge),
    disagreementBoost,
    isDisagreement: isDisagreement && side === 'away',
    confidenceLevel: factorConfidence?.level ?? null,
    confidenceScore: factorConfidence?.score ?? null,
    confidenceSummary: factorConfidence?.summary ?? null,
    confidenceMultiplier,
    // Quarter-Kelly stake (% of bankroll) off the calibrated model probability
    // and offered odds. null when there is no positive-EV stake.
    kellyStakePercent
  };
}

function moneylineValueEdgeThreshold() {
  const configured = toNumber(loadConfig().minimumMoneylineEdge, 0.05);
  return configured <= 1 ? configured * 100 : configured;
}

function moneylineOddsMaxAgeMinutes() {
  const configured = toNumber(loadConfig().moneylineOddsMaxAgeMinutes, 10);
  return configured > 0 ? configured : 10;
}

function moneylineOddsAgeMinutes(item, now = Date.now()) {
  const timestamp =
    item?.currentOdds?.oddsFetchedAt ||
    item?.currentOdds?.fetchedAt ||
    item?.currentOdds?.updatedAt;
  // Future timestamps must NOT collapse to age 0 (looks fresh). temporalAgeMinutes
  // returns null for future/invalid; callers treat null as unavailable.
  return temporalAgeMinutes(timestamp, now);
}

function moneylineOddsFreshnessReason(item, now = Date.now()) {
  const timestamp =
    item?.currentOdds?.oddsFetchedAt ||
    item?.currentOdds?.fetchedAt ||
    item?.currentOdds?.updatedAt;
  const maxAgeMinutes = moneylineOddsMaxAgeMinutes();
  const status = checkDataFreshness(timestamp, maxAgeMinutes, { now });
  if (status === 'missing') return 'odds moneyline timestamp tidak tersedia';
  if (status === 'invalid_future') return 'odds moneyline timestamp di masa depan (invalid)';
  if (status === 'stale') {
    const age = moneylineOddsAgeMinutes(item, now);
    return `odds moneyline stale ${Number(age).toFixed(0)}m > ${maxAgeMinutes.toFixed(0)}m`;
  }
  return '';
}

// Thin adapter over the declarative rule engine (src/rule_engine.js). The
// predicate logic and reason strings now live in data/rules/moneyline_rules.json
// + the JS_HANDLERS registry; this function only assembles the evaluation
// context (host-computed helpers the handlers depend on) and delegates. The
// early return for a missing option is kept here because it precedes any rule
// context. See tests/test_rule_engine_parity.js for the byte-identical contract.
function valueSafetyReasons(item, option, evolutionControls = loadEvolutionControls()) {
  if (!option) return ['odds moneyline belum tersedia'];
  const pickedTeamRecord = option.side === 'home' ? item.home?.record : item.away?.record;
  const ctx = {
    item,
    option,
    evolutionControls,
    edgeThreshold: moneylineValueEdgeThreshold(),
    oddsFreshnessReason: moneylineOddsFreshnessReason(item),
    modelFavoredSide: pureModelProbabilityForSide(item, 'home') >= pureModelProbabilityForSide(item, 'away') ? 'home' : 'away',
    pickedTeamWinPct: leagueRecordPct(pickedTeamRecord),
    getEvolutionRule,
    // Disagreement bypass: when model picks away but market favors home, this is
    // the validated asymmetric edge (scripts/model_edge_validation.py). The host
    // uses this flag to relax edge/conviction floors for this specific case.
    disagreementAwayBypass: (() => {
      const modelHomeProb = pureModelProbabilityForSide(item, 'home');
      const modelAwayProb = 100 - modelHomeProb;
      const marketHomeProb = toNumber(option.fairProbability ?? option.impliedProbability, 50);
      const marketAwayProb = 100 - marketHomeProb;
      return modelAwayProb > modelHomeProb && marketHomeProb > marketAwayProb;
    })()
  };
  return evaluateMoneyline(ctx);
}

function auditMemoryNotes(item, option, evolutionControls = loadEvolutionControls()) {
  const patterns = Array.isArray(evolutionControls?.memory?.mistake_patterns)
    ? evolutionControls.memory.mistake_patterns
    : [];
  if (patterns.length === 0) return [];

  const notes = [];
  const breakdown = item.modelBreakdown || {};
  const matchupEdge = Math.abs(toNumber(breakdown.matchupEdge, 0));
  const recordContextEdge = Math.abs(toNumber(breakdown.recordContextEdge, 0));
  const starterEdge = Math.abs(toNumber(breakdown.starterEdge, 0));
  const offenseEdge = Math.abs(toNumber(breakdown.offenseEdge, 0));
  const lineupEdge = Math.abs(toNumber(breakdown.lineupEdge, 0));
  const bullpenEdge = Math.abs(toNumber(breakdown.bullpenEdge, 0));
  const modelProbabilityEdge = option ? Math.abs(toNumber(option.modelProbability, 50) - 50) : 0;
  const valueEdge = option ? toNumber(option.edge, 0) : 0;
  const lineups = [item.lineups?.away, item.lineups?.home].filter(Boolean);
  const hasIncompleteLineup = lineups.some((lineup) => !lineup.confirmed || toNumber(lineup.count, 0) < 9);

  for (const pattern of patterns.slice(0, 12)) {
    const type = String(pattern.type || '').toLowerCase();
    const factor = String(pattern.factor || '').toLowerCase();
    const caution = String(pattern.caution || '').trim();
    if (!caution) continue;

    if ((type.includes('weak_edge') || factor.includes('edge:weak') || factor === 'market_edge') && (valueEdge < 1.0 || modelProbabilityEdge < 3) && matchupEdge < 0.05) {
      notes.push(caution);
    } else if ((type === 'record_bias' || factor === 'record_context') && ((breakdown.recordDominated && matchupEdge < 0.18) || (recordContextEdge > matchupEdge * 1.25 && matchupEdge < 0.18))) {
      notes.push(caution);
    } else if (factor === 'starting_pitcher' && starterEdge >= 0.18 && starterEdge > Math.max(offenseEdge, lineupEdge, bullpenEdge)) {
      notes.push(caution);
    } else if (factor === 'lineup' && hasIncompleteLineup) {
      notes.push(caution);
    } else if (factor === 'bullpen' && bullpenEdge >= 0.04) {
      notes.push(caution);
    } else if (type === 'factor_needs_review' && factor === 'unknown') {
      notes.push(caution);
    }
  }

  return [...new Set(notes)].slice(0, 5);
}

export function applyMoneylineValueMarket(item) {
  if (!item) return item;
  const evolutionControls = loadEvolutionControls();

  const options = ['away', 'home']
    .map((side) => moneylineValueOption(item, side))
    .filter(Boolean)
    .sort((left, right) => right.edge - left.edge);
  const best = options[0] || null;
  const reasons = valueSafetyReasons(item, best, evolutionControls);
  const auditAdjustments = reasons.filter((reason) => String(reason).toLowerCase().includes('audit guardrail'));
  const memoryNotes = auditMemoryNotes(item, best, evolutionControls);

  item.valuePick = best;
  item.moneylineValueOptions = options;
  item.auditAdjustments = auditAdjustments;
  item.auditMemoryNotes = memoryNotes;
  item.auditCautions = evolutionControls.memory?.next_game_cautions || [];
  item.activeEvolutionVersions = {
    rule: evolutionControls.activeRuleVersion,
    weights: evolutionControls.activeWeightVersion,
    memory: evolutionControls.memory?.version || 'audit-memory-v1.0'
  };
  item.betDecision = best
    ? {
        market: 'moneyline',
        status: reasons.length ? 'NO BET' : 'VALUE',
        teamId: best.teamId,
        teamName: best.teamName,
        teamAbbreviation: best.teamAbbreviation,
        odds: best.odds,
        book: best.book,
        modelProbability: best.modelProbability,
        gradingProbability: best.gradingProbability ?? best.modelProbability,
        marketResidualWeight: best.marketResidualWeight ?? 0,
        impliedProbability: best.impliedProbability,
        edge: best.edge,
        kellyStakePercent: best.kellyStakePercent,
        disagreementBoost: best.disagreementBoost ?? 1,
        isDisagreement: best.isDisagreement ?? false,
        confidenceLevel: best.confidenceLevel ?? null,
        confidenceScore: best.confidenceScore ?? null,
        confidenceSummary: best.confidenceSummary ?? null,
        confidenceMultiplier: best.confidenceMultiplier ?? 1,
        reason: reasons[0] || `model ${best.modelProbability.toFixed(1)}% vs implied ${best.impliedProbability.toFixed(1)}%`,
        reasons,
        auditAdjustments,
        auditMemoryNotes: memoryNotes
      }
    : {
        market: 'moneyline',
        status: 'LEAN ONLY',
        reason: 'odds moneyline belum tersedia',
        reasons,
        auditAdjustments,
        auditMemoryNotes: memoryNotes
      };

  // Multi-factor pick confidence for display (SP/form/H2H/injury/lineup).
  attachPickConfidence(item);

  return item;
}

// Confidence band for the picked side, derived purely from the calibrated win
// probability (the only signal shown to discriminate winners). Replaces the old
// VALUE / NO BET / LEAN ONLY status labels in the user-facing output; the
// internal betDecision.status is unchanged and still drives the ledger.
export function confidenceBand(percent) {
  if (percent >= 58) return 'tinggi';
  if (percent >= MIN_VALUE_PROBABILITY) return 'sedang';
  return 'rendah';
}

// The model's own favored side and its calibrated win probability — this is what
// "confidence" means to the reader, independent of which side the edge-based
// value option happens to land on.
function modelPickSide(item) {
  const away = toNumber(item?.away?.winProbability, 0);
  const home = toNumber(item?.home?.winProbability, 0);
  return home >= away
    ? { team: item?.home, percent: home }
    : { team: item?.away, percent: away };
}

function confidenceText(percent) {
  return `${percent.toFixed(1)}% (${confidenceBand(percent)})`;
}

export function moneylineDecisionLines(item) {
  const decision = item?.betDecision;
  if (!decision) return [];

  // A graded bet (cleared the conviction floor): show the actionable priced pick
  // framed by its confidence. By construction the value side is >=62% here.
  if (decision.status === 'VALUE') {
    const factorLevel = decision.confidenceLevel || item?.pickConfidence?.level || item?.valueConfidence?.level;
    const factorSummary = decision.confidenceSummary || item?.valueConfidence?.summary || item?.pickConfidence?.summary;
    const factorLine = factorLevel
      ? ` | factors ${factorLevel}${factorSummary ? ` — ${factorSummary}` : ''}`
      : '';
    return [
      uiKV('💰', 'Pick', `${decision.teamName} ${formatMoneylineOdds(decision.odds)} | ${decision.book}`),
      uiKV('🎚️', 'Confidence', `${confidenceText(toNumber(decision.modelProbability, 0))} | edge ${decision.edge >= 0 ? '+' : ''}${toNumber(decision.edge, 0).toFixed(1)}%${factorLine}`)
    ];
  }

  // News veto: show why VALUE was blocked (never a probability change).
  if (decision.status === 'NO BET' && decision.newsVeto) {
    const newsReasons = (decision.reasons || []).filter((r) => String(r).startsWith('news:'));
    if (newsReasons.length) {
      return [
        uiKV('🛑', 'NO BET', newsReasons[0]),
        ...(newsReasons.slice(1, 3).map((r) => uiBullet('•', r)))
      ];
    }
  }

  // Below the floor or no odds: show the MODEL's favored side as an advisory
  // lean with multi-factor confidence — never dressed up as a recommended bet.
  const model = modelPickSide(item);
  const factorLevel = decision.confidenceLevel || item?.pickConfidence?.level;
  const factorSummary = decision.confidenceSummary || item?.pickConfidence?.summary;
  const factorLine = factorLevel
    ? ` | factors ${factorLevel}${factorSummary ? ` — ${factorSummary}` : ''}`
    : '';
  const oddsContext = item.valuePick && Number.isFinite(Number(item.valuePick.odds))
    ? ` | best price ${formatMoneylineOdds(item.valuePick.odds)} ${item.valuePick.book}`
    : '';
  const lines = [
    uiKV('🎚️', 'Confidence', `${model.team?.name || 'lean'} ${confidenceText(model.percent)} (advisory)${factorLine}${oddsContext}`)
  ];
  // Surface news risk even when not hard-vetoing (informational).
  const riskFlags = item?.newsContext?.newsRisk?.flags || [];
  if (riskFlags.length) {
    lines.push(uiKV('📰', 'News risk', riskFlags.map((f) => f.flag).slice(0, 4).join(', ')));
  }
  return lines;
}

function dataQualityText(item) {
  const score = item?.quality?.score;
  const parts = [];
  if (score !== undefined && score !== null) {
    parts.push(`${Math.round(toNumber(score, 0))}/100`);
  } else {
    parts.push('unknown');
  }

  const lineup = item?.quality?.fields?.lineup?.status || item?.lineupStatus;
  const odds = item?.quality?.fields?.odds?.status || (item?.currentOdds ? 'Fresh' : 'Unavailable');
  if (lineup) parts.push(`lineup ${lineup}`);
  if (odds) parts.push(`odds ${odds}`);
  return parts.join(' | ');
}

function bettingSafetyLines(item, pick) {
  const decision = item?.betDecision || {};
  const model = modelPickSide(item);
  const confidence = confidenceText(model.percent);
  const valueText =
    decision.status === 'VALUE'
      ? `${decision.teamName} ${formatMoneylineOdds(decision.odds)} | edge +${toNumber(decision.edge, 0).toFixed(1)}%`
      : `model condong ${model.team?.name || pick?.name || 'TBD'}`;
  return [
    uiKV('🧭', 'Prediction', pick?.name || 'unavailable'),
    uiKV('💰', 'Value', valueText),
    uiKV('🎯', 'Prediksi', `${model.team?.name || 'TBD'} ${confidence}`),
    uiKV('🧪', 'Data Quality', dataQualityText(item)),
    uiKV('⚠️', 'Risk Warning', 'Analysis only; probabilities are estimates, not guarantees')
  ];
}

function weightSummary(weights) {
  if (!weights || typeof weights !== 'object') return '';
  const labels = {
    starting_pitcher: 'SP',
    sp: 'SP',
    team_strength: 'Log5',
    log5: 'Log5',
    offense: 'Off',
    bullpen: 'BP',
    recent_form: 'Form',
    form: 'Form',
    home_field: 'Home',
    home: 'Home'
  };
  return Object.entries(weights)
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([key, value]) => `${labels[key] || key} ${(Number(value) * 100).toFixed(0)}%`)
    .join(' | ');
}

function playerEntryText(entry, valueKey = 'contribution') {
  if (!entry || typeof entry !== 'object') return '';
  const name = entry.name || entry.player || 'Player';
  const value = Number(entry[valueKey]);
  const scoreText = Number.isFinite(value) ? ` ${value >= 0 ? '+' : ''}${value.toFixed(3)}` : '';
  const reason = entry.reason ? ` — ${entry.reason}` : '';
  return `${name}${scoreText}${reason}`;
}

function playerImpactLines(item) {
  const gameMode = item?.game_mode || item?.gameMode || item?.dynamicWeights?.mode;
  const weights = item?.weights_used || item?.weightsUsed || item?.dynamicWeights?.weights;
  const narrative = item?.player_narrative || item?.playerNarrative || item?.player_scores?.narrative || item?.playerScores?.narrative;
  const homeContributors = item?.key_contributors_home || item?.keyContributorsHome || item?.player_scores?.home?.key_contributors || item?.playerScores?.home?.keyContributors || [];
  const awayContributors = item?.key_contributors_away || item?.keyContributorsAway || item?.player_scores?.away?.key_contributors || item?.playerScores?.away?.keyContributors || [];
  const risks = item?.key_risks || item?.keyRisks || [];
  const lines = [];

  if (gameMode) lines.push(uiKV('🎛️', 'Game mode', gameMode));
  const weightText = weightSummary(weights);
  if (weightText) lines.push(uiKV('⚖️', 'Weights', weightText));
  if (Array.isArray(awayContributors) && awayContributors.length) {
    lines.push(uiKV('🧢', item?.away?.abbreviation || item?.away?.name || 'Away', awayContributors.slice(0, 2).map((entry) => playerEntryText(entry)).filter(Boolean).join(' | ')));
  }
  if (Array.isArray(homeContributors) && homeContributors.length) {
    lines.push(uiKV('🏠', item?.home?.abbreviation || item?.home?.name || 'Home', homeContributors.slice(0, 2).map((entry) => playerEntryText(entry)).filter(Boolean).join(' | ')));
  }
  if (Array.isArray(risks) && risks.length) {
    lines.push(uiKV('⚠️', 'Player risks', risks.slice(0, 3).map((entry) => playerEntryText(entry, 'risk')).filter(Boolean).join(' | ')));
  }
  if (narrative) lines.push(uiBullet('•', narrative));

  return lines;
}

function compactPredictionBlock(item) {
  const model = modelPickSide(item);
  return [
    uiKV('🏟️', 'Matchup', `${item.away.name} @ ${item.home.name}`),
    uiKV('🕒', 'Waktu', item.start),
    uiKV('📍', 'Stadium', item.venue),
    uiKV('📊', 'Probabilitas', `${winProbText(item.away)} | ${winProbText(item.home)}`),
    uiKV('✅', 'Pick Model', model.team?.name || item.winner?.name || 'TBD'),
    uiKV('🎯', 'Prediksi', `${model.team?.name || 'TBD'} ${confidenceText(model.percent)}`),
    ...lateUpdateLines(item, { compact: true })
  ].join('\n');
}

function splitInfoLine(value) {
  return String(value || '-')
    .split(' | ')
    .filter(Boolean)
    .map((part) => uiBullet('•', part));
}

function splitRecord(standing, type) {
  return standing?.records?.splitRecords?.find((record) => record.type === type) || null;
}

function expectedRecord(standing) {
  return standing?.records?.expectedRecords?.find((record) => record.type === 'xWinLoss') || null;
}

function splitPct(standing, type) {
  return leagueRecordPct(splitRecord(standing, type));
}

function runDiffPerGame(standing) {
  const games = Math.max(1, toNumber(standing?.gamesPlayed, 1));
  return toNumber(standing?.runDifferential, 0) / games;
}

function firstFiniteNumber(values, fallback) {
  for (const value of values) {
    const parsed = toNumber(value, Number.NaN);
    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function pythagoreanWinPct(standing, profile) {
  const games = Math.max(
    1,
    firstFiniteNumber([standing?.gamesPlayed, profile?.hitting?.gamesPlayed], 1)
  );
  const runsFor = Math.max(
    1,
    firstFiniteNumber([standing?.runsScored, profile?.hitting?.runs], DEFAULTS.rpg * games)
  );
  const runsAgainst = Math.max(
    1,
    firstFiniteNumber([standing?.runsAllowed, profile?.pitching?.runs], DEFAULTS.rpg * games)
  );
  const exponent = 1.83;
  const scoredPower = Math.pow(runsFor, exponent);
  const allowedPower = Math.pow(runsAgainst, exponent);
  return clamp(scoredPower / (scoredPower + allowedPower), 0.25, 0.75);
}

function log5Probability(teamWinPct, opponentWinPct) {
  const team = clamp(toNumber(teamWinPct, DEFAULTS.winPct), 0.05, 0.95);
  const opponent = clamp(toNumber(opponentWinPct, DEFAULTS.winPct), 0.05, 0.95);
  const denominator = team + opponent - 2 * team * opponent;
  if (Math.abs(denominator) < 0.0001) return DEFAULTS.winPct;
  return clamp((team - team * opponent) / denominator, 0.05, 0.95);
}

function signed(value) {
  const parsed = toNumber(value, 0);
  return parsed > 0 ? `+${parsed}` : String(parsed);
}

function ratePct(value, fallback = 0) {
  return `${(toNumber(value, fallback) * 100).toFixed(1)}%`;
}

function parseInnings(value) {
  if (value === null || value === undefined || value === '') return 0;
  const [whole, partial = '0'] = String(value).split('.');
  const wholeNum = Number.parseInt(whole, 10);
  const partialNum = Number.parseInt(partial, 10);
  const safeWhole = Number.isFinite(wholeNum) ? wholeNum : 0;
  const safePartial = Number.isFinite(partialNum) ? partialNum : 0;
  const outs = safeWhole * 3 + safePartial;
  return outs / 3;
}

function ymdOffset(dateYmd, offsetDays) {
  const date = new Date(`${dateYmd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function ymdDiff(laterYmd, earlierYmd) {
  const later = new Date(`${laterYmd}T00:00:00Z`);
  const earlier = new Date(`${earlierYmd}T00:00:00Z`);
  return Math.round((later.getTime() - earlier.getTime()) / 86_400_000);
}

function splitRecordText(record) {
  return record ? `${record.wins}-${record.losses} (${safeFixed(toNumber(record.pct, 0) * 100, 0)}%)` : '-';
}

function compactText(value, maxLength = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}…` : text;
}

function gamesPlayed(stat) {
  return Math.max(1, toNumber(stat?.gamesPlayed, 1));
}

function rpg(stat) {
  return toNumber(stat?.runs, DEFAULTS.rpg * gamesPlayed(stat)) / gamesPlayed(stat);
}

function statOps(stat) {
  return toNumber(stat?.ops, DEFAULTS.ops);
}

function statEra(stat) {
  return toNumber(stat?.era, DEFAULTS.era);
}

function statWhip(stat) {
  return toNumber(stat?.whip, DEFAULTS.whip);
}

function kToBb(stat) {
  const strikeouts = toNumber(stat?.strikeOuts, 0);
  const walks = toNumber(stat?.baseOnBalls, 0);
  if (strikeouts <= 0 && walks <= 0) return 2.2;
  return strikeouts / Math.max(1, walks);
}

function statIso(stat) {
  return toNumber(stat?.iso, DEFAULTS.iso);
}

function battingKRate(stat) {
  return toNumber(stat?.strikeoutsPerPlateAppearance, DEFAULTS.kRate);
}

function battingBbRate(stat) {
  return toNumber(stat?.walksPerPlateAppearance, DEFAULTS.bbRate);
}

function pitchingKMinusBb(stat) {
  return toNumber(stat?.strikeoutsMinusWalksPercentage, DEFAULTS.kMinusBb);
}

function pitchingHr9(stat) {
  return toNumber(stat?.homeRunsPer9, DEFAULTS.hr9);
}

function pitcherLabel(pitcher, stats) {
  if (!pitcher?.fullName) return 'TBD';
  const hand = pitcher.pitchHand?.code ? `${pitcher.pitchHand.code}HP ` : '';
  if (!stats) return `${pitcher.fullName} ${hand}`.trim();
  return `${pitcher.fullName} ${hand}ERA ${safeFixed(stats.era)} WHIP ${safeFixed(stats.whip)}`;
}

function normalizedKey(value) {
  return String(value || '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
}

function collectOpenerNoteText(value, parentKey = '') {
  if (!value) return [];
  if (typeof value === 'string') {
    return OPENER_NOTE_KEYS.has(parentKey) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectOpenerNoteText(item, parentKey));
  }
  if (typeof value !== 'object') return [];

  const lines = [];
  for (const [key, nested] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    const isNoteKey =
      OPENER_NOTE_KEYS.has(key) ||
      OPENER_NOTE_KEYS.has(normalized) ||
      /note|description|summary|role|type/i.test(key);
    if (typeof nested === 'string' && isNoteKey) {
      lines.push(nested);
    } else if (nested && typeof nested === 'object') {
      lines.push(...collectOpenerNoteText(nested, isNoteKey ? normalized : parentKey));
    }
  }
  return lines;
}

function pitcherRoleFromText(text) {
  const lowered = String(text || '').toLowerCase();
  if (lowered.includes('bulk') && !lowered.includes('opener')) return 'bulk';
  if (OPENER_KEYWORD_RE.test(lowered)) return 'opener';
  return 'starter';
}

function pitcherStartRatio(stats) {
  const gamesStarted = toNumber(stats?.gamesStarted ?? stats?.starts, Number.NaN);
  const appearances = toNumber(
    stats?.gamesPitched ?? stats?.appearances ?? stats?.games,
    Number.NaN
  );
  if (!Number.isFinite(gamesStarted) || !Number.isFinite(appearances) || appearances <= 0) {
    return null;
  }
  return clamp(gamesStarted / appearances, 0, 1);
}

function detectOpenerSituation(game, side, pitcher, stats) {
  const teamEntry = game?.teams?.[side] || {};
  const noteText = [
    ...collectOpenerNoteText(game),
    ...collectOpenerNoteText(teamEntry),
    ...collectOpenerNoteText(pitcher)
  ].join(' ');
  const noteMatch = OPENER_KEYWORD_RE.test(noteText);
  const startRatio = pitcherStartRatio(stats);
  const appearances = toNumber(stats?.gamesPitched ?? stats?.appearances ?? stats?.games, 0);
  const lowStartShare = startRatio !== null && startRatio < 0.3 && appearances >= 10;

  if (noteMatch) {
    return {
      isOpener: true,
      pitcherRole: pitcherRoleFromText(noteText),
      confidence: lowStartShare ? 'high' : 'medium',
      careerGsPct: startRatio,
      note: noteText.trim()
    };
  }

  if (lowStartShare) {
    return {
      isOpener: true,
      pitcherRole: 'opener',
      confidence: 'medium',
      careerGsPct: startRatio,
      note: 'Career GS% below opener threshold.'
    };
  }

  return {
    isOpener: false,
    pitcherRole: 'starter',
    confidence: 'low',
    careerGsPct: startRatio
  };
}

function effectivePitcherStats(stats, openerSituation) {
  return openerSituation?.isOpener ? null : stats;
}

function getTeamStatMap(statsData) {
  const teams = new Map();

  for (const block of statsData.stats || []) {
    const group = block.group?.displayName?.toLowerCase();
    if (!group) continue;

    for (const split of block.splits || []) {
      const teamId = split.team?.id;
      if (!teamId) continue;

      if (!teams.has(teamId)) {
        teams.set(teamId, {
          team: split.team,
          hitting: null,
          hittingAdvanced: null,
          pitching: null,
          pitchingAdvanced: null
        });
      }

      const profile = teams.get(teamId);
      const type = String(block.type?.displayName || '').toLowerCase();
      if (group === 'hitting' && type.includes('season') && !type.includes('advanced')) profile.hitting = split.stat;
      if (group === 'hitting' && type.includes('advanced')) profile.hittingAdvanced = split.stat;
      if (group === 'pitching' && type.includes('season') && !type.includes('advanced')) profile.pitching = split.stat;
      if (group === 'pitching' && type.includes('advanced')) profile.pitchingAdvanced = split.stat;
    }
  }

  return teams;
}

function getRollingTeamStatMap(statsData) {
  const teams = new Map();

  for (const block of statsData.stats || []) {
    const group = block.group?.displayName?.toLowerCase();
    const type = String(block.type?.displayName || '').toLowerCase();
    if (!group || !type.includes('daterange')) continue;

    for (const split of block.splits || []) {
      const teamId = split.team?.id;
      if (!teamId) continue;

      if (!teams.has(teamId)) {
        teams.set(teamId, {
          team: split.team,
          hitting: null,
          pitching: null,
          games: 0
        });
      }

      const profile = teams.get(teamId);
      if (group === 'hitting') {
        profile.hitting = split.stat;
        profile.games = Math.max(profile.games, toNumber(split.stat?.gamesPlayed, 0));
      }
      if (group === 'pitching') {
        profile.pitching = split.stat;
        profile.games = Math.max(profile.games, toNumber(split.stat?.gamesPlayed, 0));
      }
    }
  }

  return teams;
}

// Season vs last-21d offense/prevention blend. Rolling form is the real-data
// signal season averages miss (hot/cold stretches, post-trade lineups). Require
// enough games so a 3-game noise spike cannot dominate.
function blendedTeamOffenseEdge(seasonHome, seasonAway, rollingHome, rollingAway) {
  const seasonEdge =
    (rpg(seasonHome?.hitting) - rpg(seasonAway?.hitting)) / 2.2 +
    (statOps(seasonHome?.hitting) - statOps(seasonAway?.hitting)) / 0.14 +
    (statIso(seasonHome?.hittingAdvanced) - statIso(seasonAway?.hittingAdvanced)) / 0.1 +
    (battingKRate(seasonAway?.hittingAdvanced) - battingKRate(seasonHome?.hittingAdvanced)) / 0.16 +
    (battingBbRate(seasonHome?.hittingAdvanced) - battingBbRate(seasonAway?.hittingAdvanced)) / 0.12;

  const homeGames = toNumber(rollingHome?.games, 0);
  const awayGames = toNumber(rollingAway?.games, 0);
  if (homeGames < 8 || awayGames < 8 || !rollingHome?.hitting || !rollingAway?.hitting) {
    return { edge: seasonEdge, rollingWeight: 0, rollingEdge: 0 };
  }

  const rollingEdge =
    (rpg(rollingHome.hitting) - rpg(rollingAway.hitting)) / 2.2 +
    (statOps(rollingHome.hitting) - statOps(rollingAway.hitting)) / 0.14;
  const sample = Math.min(homeGames, awayGames);
  const rollingWeight = clamp((sample - 7) / 12, 0, 0.45);
  return {
    edge: seasonEdge * (1 - rollingWeight) + rollingEdge * rollingWeight,
    rollingWeight,
    rollingEdge
  };
}

function blendedTeamPreventionEdge(seasonHome, seasonAway, rollingHome, rollingAway) {
  const seasonEdge =
    (statEra(seasonAway?.pitching) - statEra(seasonHome?.pitching)) / 1.8 +
    (statWhip(seasonAway?.pitching) - statWhip(seasonHome?.pitching)) / 0.55 +
    (pitchingKMinusBb(seasonHome?.pitchingAdvanced) - pitchingKMinusBb(seasonAway?.pitchingAdvanced)) / 0.16 +
    (pitchingHr9(seasonAway?.pitchingAdvanced) - pitchingHr9(seasonHome?.pitchingAdvanced)) / 1.2;

  const homeGames = toNumber(rollingHome?.games, 0);
  const awayGames = toNumber(rollingAway?.games, 0);
  if (homeGames < 8 || awayGames < 8 || !rollingHome?.pitching || !rollingAway?.pitching) {
    return { edge: seasonEdge, rollingWeight: 0, rollingEdge: 0 };
  }

  const homePitch = rollingHome.pitching;
  const awayPitch = rollingAway.pitching;
  const rollingEdge =
    (statEra(awayPitch) - statEra(homePitch)) / 1.8 +
    (statWhip(awayPitch) - statWhip(homePitch)) / 0.55 +
    (toNumber(homePitch.homeRunsPer9, DEFAULTS.hr9) - toNumber(awayPitch.homeRunsPer9, DEFAULTS.hr9)) / 1.2 +
    (toNumber(homePitch.strikeoutWalkRatio, 2.2) - toNumber(awayPitch.strikeoutWalkRatio, 2.2)) / 4.0;
  const sample = Math.min(homeGames, awayGames);
  const rollingWeight = clamp((sample - 7) / 12, 0, 0.4);
  return {
    edge: seasonEdge * (1 - rollingWeight) + rollingEdge * rollingWeight,
    rollingWeight,
    rollingEdge
  };
}

function rollingFormLine(team, rollingProfile) {
  const label = team.abbreviation || team.name;
  if (!rollingProfile?.hitting && !rollingProfile?.pitching) {
    return `${label} L21: data belum cukup`;
  }
  const games = toNumber(rollingProfile.games, 0);
  const hit = rollingProfile.hitting;
  const pit = rollingProfile.pitching;
  const parts = [`${label} L${games || 21}`];
  if (hit) parts.push(`${safeFixed(rpg(hit), 2)} R/G OPS ${safeFixed(statOps(hit), 3)}`);
  if (pit) parts.push(`staff ERA ${safeFixed(statEra(pit))} WHIP ${safeFixed(statWhip(pit))}`);
  return parts.join(' ');
}

function getStandingMap(standingsData) {
  const teams = new Map();

  for (const division of standingsData.records || []) {
    for (const teamRecord of division.teamRecords || []) {
      if (teamRecord.team?.id) {
        teams.set(teamRecord.team.id, teamRecord);
      }
    }
  }

  return teams;
}

async function fetchRecentTeamGames(teamIds, dateYmd, daysBack = 3) {
  const params = new URLSearchParams({
    sportId: '1',
    gameTypes: 'R',
    startDate: ymdOffset(dateYmd, -daysBack),
    endDate: ymdOffset(dateYmd, -1),
    hydrate: 'team'
  });

  const idSet = new Set(teamIds);
  const data = await fetchJson(`${MLB_BASE_URL}/schedule?${params}`);
  return (data.dates || [])
    .flatMap((date) => date.games || [])
    .filter((game) => game.status?.abstractGameState === 'Final')
    .filter((game) => idSet.has(game.teams.away.team.id) || idSet.has(game.teams.home.team.id));
}

async function fetchScheduleFatigueProfiles(teamIds, dateYmd) {
  const profiles = new Map(teamIds.map((teamId) => [teamId, finalizeScheduleFatigueProfile(teamId, [], dateYmd)]));
  const games = await fetchRecentTeamGames(teamIds, dateYmd, 10);

  for (const teamId of teamIds) {
    const teamGames = games
      .filter((game) => game.teams.away.team.id === teamId || game.teams.home.team.id === teamId)
      .map((game) => ({
        date: game.officialDate || String(game.gameDate || '').slice(0, 10),
        side: game.teams.away.team.id === teamId ? 'away' : 'home'
      }))
      .filter((game) => game.date);
    profiles.set(teamId, finalizeScheduleFatigueProfile(teamId, teamGames, dateYmd));
  }

  return profiles;
}

function finalizeScheduleFatigueProfile(teamId, games, dateYmd) {
  const sorted = [...games].sort((left, right) => String(right.date).localeCompare(String(left.date)));
  const lastGame = sorted[0] || null;
  const restDays = lastGame ? Math.max(0, ymdDiff(dateYmd, lastGame.date) - 1) : 10;
  const dateCounts = new Map();
  for (const game of sorted.filter((item) => ymdDiff(dateYmd, item.date) <= 3)) {
    dateCounts.set(game.date, (dateCounts.get(game.date) || 0) + 1);
  }
  const doubleheaderLast3Days = [...dateCounts.values()].some((count) => count >= 2);

  let roadStreak = 0;
  for (const game of sorted) {
    if (game.side !== 'away') break;
    roadStreak += 1;
  }

  let fatiguePoints = 0;
  if (sorted.length >= 9) fatiguePoints += 2;
  else if (sorted.length >= 7) fatiguePoints += 1;
  if (doubleheaderLast3Days) fatiguePoints += 1;
  if (roadStreak >= 7) fatiguePoints += 2;
  else if (roadStreak >= 4) fatiguePoints += 1;
  if (restDays === 0) fatiguePoints += 1;
  const fatigueLevel = fatiguePoints >= 3 ? 'high' : fatiguePoints >= 1 ? 'medium' : 'low';

  return {
    teamId,
    restDays,
    roadStreak,
    recentGameCount: sorted.length,
    doubleheaderLast3Days,
    fatigueLevel,
    offenseAdjustment: doubleheaderLast3Days ? -0.05 : 0,
    teamAdjustment: roadStreak >= 7 ? -0.03 : 0,
    line: `${sorted.length}G last 10d, rest ${restDays}d, road streak ${roadStreak}, fatigue ${fatigueLevel}${doubleheaderLast3Days ? ', doubleheader flag' : ''}`
  };
}

function pitcherRestProfile(pitcher, recentStarts, dateYmd) {
  if (!pitcher) {
    return {
      pitcher: 'TBD',
      restDays: null,
      multiplier: 1,
      flag: 'SP rest unavailable'
    };
  }

  const lastStartDate = recentStarts?.lastStartDate || '';
  const rawRestDays = lastStartDate ? Math.max(0, ymdDiff(dateYmd, lastStartDate) - 1) : null;
  const restDays = rawRestDays !== null && rawRestDays <= 30 ? rawRestDays : null;
  const multiplier = restDays === null ? 1 : restDays <= 3 ? 0.85 : restDays >= 6 ? 0.93 : 1;
  const label =
    restDays === null
      ? 'SP rest unavailable'
      : restDays <= 3
        ? `${pitcher.fullName} short rest ${restDays}d`
        : restDays >= 6
          ? `${pitcher.fullName} long rest ${restDays}d`
          : `${pitcher.fullName} normal rest ${restDays}d`;

  return {
    pitcher: pitcher.fullName,
    restDays,
    multiplier,
    flag: label
  };
}

function scheduleFatigueEdge(homeFatigue, awayFatigue, homeRest, awayRest) {
  const homePenalty =
    Math.abs(toNumber(homeFatigue.offenseAdjustment, 0)) +
    Math.abs(toNumber(homeFatigue.teamAdjustment, 0)) +
    (toNumber(homeRest.multiplier, 1) < 1 ? (1 - toNumber(homeRest.multiplier, 1)) * 0.25 : 0);
  const awayPenalty =
    Math.abs(toNumber(awayFatigue.offenseAdjustment, 0)) +
    Math.abs(toNumber(awayFatigue.teamAdjustment, 0)) +
    (toNumber(awayRest.multiplier, 1) < 1 ? (1 - toNumber(awayRest.multiplier, 1)) * 0.25 : 0);
  return clamp(awayPenalty - homePenalty, -0.08, 0.08);
}

function fatigueFlagLines(away, home, awaySchedule, homeSchedule, awayRest, homeRest) {
  const lines = [
    `${away.abbreviation || away.name} schedule ${awaySchedule.line}`,
    `${home.abbreviation || home.name} schedule ${homeSchedule.line}`
  ];

  for (const [team, schedule] of [
    [away, awaySchedule],
    [home, homeSchedule]
  ]) {
    if (schedule.doubleheaderLast3Days) {
      lines.push(`${team.abbreviation || team.name} doubleheader in last 3 days: offense fatigue flag`);
    }
    if (schedule.roadStreak >= 7) {
      lines.push(`${team.abbreviation || team.name} ${schedule.roadStreak}-game road streak: team fatigue flag`);
    }
  }

  for (const rest of [awayRest, homeRest]) {
    if (rest.restDays !== null && (rest.restDays < 4 || rest.restDays >= 6)) {
      lines.push(rest.flag);
    }
  }

  return lines;
}

async function fetchBoxscore(gamePk) {
  return fetchJson(`${MLB_BASE_URL}/game/${gamePk}/boxscore`);
}

async function fetchLiveFeed(gamePk) {
  return fetchJson(`${MLB_BASE_URL}/game/${gamePk}/feed/live`);
}

function lineupPlayerName(player) {
  return player?.person?.fullName || player?.person?.displayName || player?.person?.boxscoreName || null;
}

function battingOrderSlot(player) {
  const raw = Number.parseInt(player?.battingOrder, 10);
  if (!Number.isFinite(raw)) return 99;
  return Math.floor(raw / 100) || raw;
}

function hitterBattingStats(player) {
  return (
    player?.seasonStats?.batting ||
    player?.stats?.batting ||
    player?.stat?.batting ||
    player?.batting ||
    {}
  );
}

function firstStatNumber(stats, keys, fallback = 0) {
  for (const key of keys) {
    const value = stats?.[key];
    if (value === undefined || value === null || value === '') continue;
    const parsed = toNumber(value, Number.NaN);
    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function hitterLineupScore(player, slot) {
  const stats = hitterBattingStats(player);
  const plateAppearances = firstStatNumber(stats, ['plateAppearances', 'pa'], 0);
  const atBats = firstStatNumber(stats, ['atBats', 'ab'], 0);
  const known = plateAppearances >= 25 || atBats >= 25 || stats.ops !== undefined || stats.onBasePercentage !== undefined;
  if (!known) return { value: 0, known: false };

  const ops = firstStatNumber(stats, ['ops'], DEFAULTS.ops);
  const obp = firstStatNumber(stats, ['obp', 'onBasePercentage'], 0.32);
  const slg = firstStatNumber(stats, ['slg', 'sluggingPercentage'], 0.4);
  const homeRuns = firstStatNumber(stats, ['homeRuns', 'hr'], 0);
  const sample = Math.max(plateAppearances, atBats, 1);
  const powerPerPa = homeRuns / sample;
  const slotWeight = slot <= 2 ? 1.18 : slot <= 5 ? 1.08 : slot <= 7 ? 0.92 : 0.78;
  const score =
    ((ops - DEFAULTS.ops) / 0.22) * 0.075 +
    ((obp - 0.32) / 0.08) * 0.035 +
    ((slg - 0.4) / 0.14) * 0.035 +
    ((powerPerPa - 0.035) / 0.035) * 0.02;

  return {
    value: clamp(score * slotWeight, -0.16, 0.18),
    known: true
  };
}

function extractLineupProfile(boxTeam) {
  const players = Object.values(boxTeam?.players || {});
  const hitters = players
    .filter((player) => player?.battingOrder)
    .sort((a, b) => Number.parseInt(a.battingOrder, 10) - Number.parseInt(b.battingOrder, 10));
  const slots = new Map();

  for (const hitter of hitters) {
    const slot = battingOrderSlot(hitter);
    if (slot >= 1 && slot <= 9 && !slots.has(slot)) {
      slots.set(slot, hitter);
    }
  }

  const orderedHitters = [...slots.entries()]
    .sort(([slotA], [slotB]) => slotA - slotB)
    .map(([, hitter]) => hitter);
  const topFive = orderedHitters
    .slice(0, 5)
    .map(lineupPlayerName)
    .filter(Boolean);
  const leadoffStats = hitterBattingStats(orderedHitters[0]);
  const leadoffObpValue = orderedHitters[0]
    ? firstStatNumber(leadoffStats, ['obp', 'onBasePercentage'], Number.NaN)
    : Number.NaN;
  const hitterScores = orderedHitters.map((hitter, index) => hitterLineupScore(hitter, index + 1));
  const knownStatCount = hitterScores.filter((score) => score.known).length;
  const weightedScore =
    knownStatCount >= 4
      ? hitterScores.reduce((sum, score) => sum + score.value, 0) / Math.max(1, orderedHitters.length)
      : 0;

  return {
    confirmed: orderedHitters.length >= 9,
    count: orderedHitters.length,
    topFive,
    leadoffObp: Number.isFinite(leadoffObpValue) ? leadoffObpValue : null,
    knownStatCount,
    qualityScore: clamp(weightedScore, -0.12, 0.12)
  };
}

async function fetchGameLineupProfile(gamePk) {
  const boxscore = await fetchBoxscore(gamePk);

  return {
    away: extractLineupProfile(boxscore.teams?.away),
    home: extractLineupProfile(boxscore.teams?.home)
  };
}

async function fetchBullpenProfiles(teamIds, dateYmd) {
  const profiles = new Map(
    teamIds.map((teamId) => [
      teamId,
      {
        teamId,
        games: 0,
        bullpenPitches: 0,
        bullpenOuts: 0,
        relieverAppearances: 0,
        relieverDates: new Map(),
        highPitchRelievers: 0
      }
    ])
  );
  const games = await fetchRecentTeamGames(teamIds, dateYmd, 3);

  const MAX_CONCURRENT = 5;
  const queue = [...games];
  const results = [];
  async function runNext() {
    while (queue.length) {
      const game = queue.shift();
      let boxscore;
      try {
        boxscore = await fetchBoxscore(game.gamePk);
      } catch {
        continue;
      }

      for (const side of ['away', 'home']) {
        const team = game.teams[side].team;
        const profile = profiles.get(team.id);
        if (!profile) continue;

        profile.games += 1;
        const boxTeam = boxscore.teams?.[side];
        for (const personId of boxTeam?.pitchers || []) {
          const player = boxTeam.players?.[`ID${personId}`];
          const stats = player?.stats?.pitching || {};
          if (toNumber(stats.gamesStarted, 0) > 0) continue;

          const pitches = toNumber(stats.numberOfPitches, 0);
          profile.bullpenPitches += pitches;
          profile.bullpenOuts += Math.round(parseInnings(stats.inningsPitched) * 3);
          profile.relieverAppearances += 1;
          if (pitches >= 25) profile.highPitchRelievers += 1;

          const key = String(personId);
          if (!profile.relieverDates.has(key)) profile.relieverDates.set(key, new Set());
          profile.relieverDates.get(key).add(game.officialDate || game.gameDate);
        }
      }
    }
  }
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, games.length) }, () => runNext());
  await Promise.all(workers);

  for (const [teamId, profile] of profiles.entries()) {
    profiles.set(teamId, finalizeBullpenProfile(profile));
  }

  return profiles;
}

function finalizeBullpenProfile(profile) {
  const backToBackRelievers = [...profile.relieverDates.values()].filter((dates) => dates.size >= 2).length;
  const innings = profile.bullpenOuts / 3;
  const fatigueScore =
    profile.bullpenPitches / 120 +
    backToBackRelievers * 0.2 +
    profile.highPitchRelievers * 0.12 +
    Math.max(0, profile.games - 2) * 0.15;
  const level = fatigueScore >= 1.7 ? 'high' : fatigueScore >= 0.9 ? 'medium' : 'low';

  return {
    teamId: profile.teamId,
    games: profile.games,
    bullpenPitches: profile.bullpenPitches,
    bullpenInnings: innings,
    relieverAppearances: profile.relieverAppearances,
    backToBackRelievers,
    highPitchRelievers: profile.highPitchRelievers,
    fatigueScore,
    level,
    line: `${profile.games}G last 3d, ${Math.round(profile.bullpenPitches)} pitches, ${safeFixed(innings, 1)} IP, B2B relievers ${backToBackRelievers}, fatigue ${level}`
  };
}

async function fetchSchedule(dateYmd) {
  const params = new URLSearchParams({
    sportId: '1',
    date: dateYmd,
    gameTypes: 'R',
    hydrate: 'probablePitcher,team,venue,weather,linescore'
  });

  const data = await fetchJson(`${MLB_BASE_URL}/schedule?${params}`);
  const allGames = (data.dates || []).flatMap((date) => date.games || []);
  const seen = new Set();
  return allGames.filter((game) => {
    if (seen.has(game.gamePk)) return false;
    seen.add(game.gamePk);
    return true;
  });
}

function injuryTransactionStartDate(season) {
  return `${season}-01-01`;
}

function injuryNoteFromTransaction(description) {
  const text = compactText(description, 220);
  if (!text) return '';

  const injuredListMatch = text.match(/injured list(?: retroactive to [^.]+)?\.\s*(.+)$/i);
  if (injuredListMatch?.[1]) return compactText(injuredListMatch[1], 120);

  const transferredMatch = text.match(/transferred .* injured list\.\s*(.+)$/i);
  if (transferredMatch?.[1]) return compactText(transferredMatch[1], 120);

  return compactText(text, 120);
}

async function fetchTeamInjuryProfile(teamId, dateYmd, season) {
  const rosterParams = new URLSearchParams({
    rosterType: '40Man',
    date: dateYmd
  });
  const transactionParams = new URLSearchParams({
    teamId: String(teamId),
    startDate: injuryTransactionStartDate(season),
    endDate: dateYmd
  });

  const [rosterData, transactionData] = await Promise.all([
    fetchJson(`${MLB_BASE_URL}/teams/${teamId}/roster?${rosterParams}`),
    fetchJson(`${MLB_BASE_URL}/transactions?${transactionParams}`)
  ]);

  const latestInjuryTransactions = new Map();
  for (const transaction of transactionData.transactions || []) {
    const personId = transaction.person?.id;
    const description = transaction.description || '';
    if (!personId || !/injured list|injury|injured/i.test(description)) continue;

    latestInjuryTransactions.set(personId, {
      date: transaction.date || '',
      description,
      note: injuryNoteFromTransaction(description)
    });
  }

  return (rosterData.roster || [])
    .filter((item) => /injured/i.test(item.status?.description || ''))
    .map((item) => {
      const latest = latestInjuryTransactions.get(item.person?.id) || null;
      return {
        id: item.person?.id,
        name: item.person?.fullName || 'Unknown player',
        position: item.position?.abbreviation || item.position?.name || '-',
        status: item.status?.description || 'Injured',
        note: latest?.note || '',
        transactionDate: latest?.date || ''
      };
    })
    .sort((a, b) => {
      const statusSort = String(a.status).localeCompare(String(b.status));
      return statusSort || String(a.name).localeCompare(String(b.name));
    });
}

async function fetchInjuryProfiles(teamIds, dateYmd, season) {
  const injuries = new Map();

  await Promise.all(
    teamIds.map(async (teamId) => {
      try {
        injuries.set(teamId, await fetchTeamInjuryProfile(teamId, dateYmd, season));
      } catch {
        injuries.set(teamId, []);
      }
    })
  );

  return injuries;
}

async function fetchTeamStats(season, asOfDateYmd = null) {
  // Prefer season-to-date through as_of to avoid including future games when
  // this helper is used in historical or late-season evaluation contexts.
  // Without asOfDateYmd, fall back to full season (live-only; not backtest-safe).
  const params = new URLSearchParams({
    season: String(season),
    group: 'hitting,pitching',
    sportIds: '1',
    gameType: 'R'
  });
  if (asOfDateYmd) {
    const seasonOpen = seasonStartDate(season);
    const endDate = String(asOfDateYmd).slice(0, 10);
    const startDate = seasonOpen <= endDate ? seasonOpen : endDate;
    params.set('stats', 'byDateRange');
    params.set('startDate', startDate);
    params.set('endDate', endDate);
  } else {
    params.set('stats', 'season,seasonAdvanced');
  }

  return getTeamStatMap(await fetchJson(`${MLB_BASE_URL}/teams/stats?${params}`));
}

async function fetchRollingTeamStats(season, dateYmd, days = ROLLING_FORM_DAYS) {
  const { startDate, endDate } = rollingFormWindow(dateYmd, days);
  // Guard: if window starts before season open, clamp so API returns real splits.
  const seasonOpen = seasonStartDate(season);
  const safeStart = startDate < seasonOpen ? seasonOpen : startDate;
  if (safeStart > endDate) return new Map();

  const params = new URLSearchParams({
    season: String(season),
    stats: 'byDateRange',
    group: 'hitting,pitching',
    sportIds: '1',
    gameType: 'R',
    startDate: safeStart,
    endDate
  });

  return getRollingTeamStatMap(await fetchJson(`${MLB_BASE_URL}/teams/stats?${params}`));
}

async function fetchStandings(season, dateYmd) {
  const params = new URLSearchParams({
    leagueId: '103,104',
    season: String(season),
    standingsTypes: 'regularSeason',
    date: dateYmd
  });

  return getStandingMap(await fetchJson(`${MLB_BASE_URL}/standings?${params}`));
}

async function fetchPitcherStats(personId, season, asOfDateYmd = null) {
  if (!personId) return null;

  const params = new URLSearchParams({
    group: 'pitching',
    season: String(season),
    gameType: 'R'
  });
  // Season-to-date through as_of when available (historical/leakage-safe).
  // Full-season without asOf is live-only and not backtest-safe.
  if (asOfDateYmd) {
    const seasonOpen = seasonStartDate(season);
    const endDate = String(asOfDateYmd).slice(0, 10);
    const startDate = seasonOpen <= endDate ? seasonOpen : endDate;
    params.set('stats', 'byDateRange');
    params.set('startDate', startDate);
    params.set('endDate', endDate);
  } else {
    params.set('stats', 'season');
  }

  const data = await fetchJson(`${MLB_BASE_URL}/people/${personId}/stats?${params}`);
  return data.stats?.[0]?.splits?.[0]?.stat || null;
}

async function fetchPerson(personId) {
  if (!personId) return null;
  const data = await fetchJson(`${MLB_BASE_URL}/people/${personId}`);
  return data.people?.[0] || null;
}

async function fetchPitcherRecentStarts(personId, season, limit = 5, asOfDateYmd = null) {
  if (!personId) return null;

  const params = new URLSearchParams({
    stats: 'gameLog',
    group: 'pitching',
    season: String(season),
    gameType: 'R'
  });
  const data = await fetchJson(`${MLB_BASE_URL}/people/${personId}/stats?${params}`);
  // Strict as-of: only starts before the prediction date. Without a cutoff we
  // would include future season games (lookahead). Missing asOf → empty, not
  // full-season slice(-limit).
  const started = (data.stats?.[0]?.splits || []).filter(
    (split) => toNumber(split.stat?.gamesStarted, 0) > 0
  );
  const eligible = asOfDateYmd
    ? filterSplitsBeforeDate(started, asOfDateYmd)
    : [];
  const starts = eligible.slice(-limit);

  return summarizePitcherStarts(starts);
}

function summarizePitcherStarts(starts) {
  if (!starts || starts.length === 0) {
    return {
      games: 0,
      line: 'recent starts unavailable'
    };
  }

  const innings = starts.reduce((sum, split) => sum + parseInnings(split.stat?.inningsPitched), 0);
  const earnedRuns = starts.reduce((sum, split) => sum + toNumber(split.stat?.earnedRuns, 0), 0);
  const hits = starts.reduce((sum, split) => sum + toNumber(split.stat?.hits, 0), 0);
  const walks = starts.reduce((sum, split) => sum + toNumber(split.stat?.baseOnBalls, 0), 0);
  const strikeouts = starts.reduce((sum, split) => sum + toNumber(split.stat?.strikeOuts, 0), 0);
  const homeRuns = starts.reduce((sum, split) => sum + toNumber(split.stat?.homeRuns, 0), 0);
  const pitches = starts.reduce((sum, split) => sum + toNumber(split.stat?.numberOfPitches, 0), 0);
  const era = innings > 0 ? (earnedRuns * 9) / innings : 0;
  const whip = innings > 0 ? (hits + walks) / innings : 0;
  const kbb = strikeouts / Math.max(1, walks);
  const last = starts[starts.length - 1];

  return {
    games: starts.length,
    innings,
    era,
    whip,
    strikeouts,
    walks,
    homeRuns,
    avgPitches: pitches / starts.length,
    lastStartDate: last?.date || '',
    lastStartPitches: toNumber(last?.stat?.numberOfPitches, 0),
    line: `last ${starts.length}: ERA ${safeFixed(era)}, WHIP ${safeFixed(whip)}, K/BB ${safeFixed(kbb, 1)}, HR ${homeRuns}, avg ${safeFixed(pitches / starts.length, 0)} pitches`
  };
}

function boxscorePlayer(boxscore, side, personId) {
  return boxscore?.teams?.[side]?.players?.[`ID${personId}`] || null;
}

function actualStarterForSide(boxscore, side) {
  const boxTeam = boxscore?.teams?.[side];
  for (const personId of boxTeam?.pitchers || []) {
    const player = boxTeam?.players?.[`ID${personId}`];
    if (toNumber(player?.stats?.pitching?.gamesStarted, 0) > 0) {
      return {
        id: Number(personId),
        fullName: lineupPlayerName(player) || player?.person?.fullName || `Pitcher ${personId}`
      };
    }
  }
  return null;
}

function baseKey(base) {
  return `${base?.start || ''}:${base?.end || ''}`;
}

function scoreKey(runner) {
  return `${runner?.details?.event || ''}:${runner?.movement?.start || ''}:score`;
}

function matchupSplitLine(team, standing, opponentStarter, venueSplitType) {
  const hand = opponentStarter?.pitchHand?.code;
  if (!hand || !['L', 'R'].includes(hand)) {
    return `${team.abbreviation || team.name} vs starter hand: unavailable`;
  }

  const baseType = hand === 'L' ? 'left' : 'right';
  const venueType =
    hand === 'L'
      ? venueSplitType === 'home'
        ? 'leftHome'
        : 'leftAway'
      : venueSplitType === 'home'
        ? 'rightHome'
        : 'rightAway';
  const overall = splitRecord(standing, baseType);
  const venue = splitRecord(standing, venueType);
  const handLabel = hand === 'L' ? 'LHP' : 'RHP';

  return `${team.abbreviation || team.name} vs ${handLabel}: ${splitRecordText(overall)}, ${venueSplitType} ${splitRecordText(venue)}`;
}

async function fetchHeadToHead(game, season, dateYmd) {
  const awayTeamId = game.teams.away.team.id;
  const homeTeamId = game.teams.home.team.id;
  const params = new URLSearchParams({
    sportId: '1',
    season: String(season),
    gameTypes: 'R',
    teamId: String(awayTeamId),
    opponentId: String(homeTeamId),
    startDate: seasonStartDate(season),
    endDate: dateYmd,
    hydrate: 'linescore'
  });

  const data = await fetchJson(`${MLB_BASE_URL}/schedule?${params}`);
  const games = (data.dates || [])
    .flatMap((date) => date.games || [])
    .filter((item) => item.gamePk !== game.gamePk)
    .filter((item) => item.status?.abstractGameState === 'Final')
    .filter((item) => Number.isFinite(item.teams?.away?.score) && Number.isFinite(item.teams?.home?.score));

  let awayWins = 0;
  let homeWins = 0;

  for (const item of games) {
    const winnerId =
      item.teams.away.score > item.teams.home.score
        ? item.teams.away.team.id
        : item.teams.home.team.id;

    if (winnerId === awayTeamId) awayWins += 1;
    if (winnerId === homeTeamId) homeWins += 1;
  }

  const total = awayWins + homeWins;
  const awayProbability = ((awayWins + 1) / (total + 2)) * 100;
  const homeProbability = 100 - awayProbability;

  return {
    games: total,
    awayWins,
    homeWins,
    awayProbability,
    homeProbability
  };
}

function finalGameResult(game, dateYmd) {
  const awayScore = toNumber(game.teams?.away?.score, Number.NaN);
  const homeScore = toNumber(game.teams?.home?.score, Number.NaN);
  const awayTeam = game.teams.away.team;
  const homeTeam = game.teams.home.team;
  // A tie (equal finite scores) or non-finite scores has no winner. Emitting a
  // concrete home "winner" here would settle a staked bet as a win/loss instead
  // of a push and corrupt the ledger. Return null-id winner/loser so settleBet's
  // (winnerId == null → push) branch fires. Regular-season ties are rare but
  // suspended/shortened finals with equal scores do occur.
  const decided = Number.isFinite(awayScore) && Number.isFinite(homeScore) && awayScore !== homeScore;
  const winnerTeam = decided ? (awayScore > homeScore ? awayTeam : homeTeam) : null;
  const loserTeam = decided ? (awayScore > homeScore ? homeTeam : awayTeam) : null;

  return {
    gamePk: game.gamePk,
    dateYmd,
    status: game.status?.detailedState || 'Final',
    away: {
      id: awayTeam.id,
      name: awayTeam.name,
      abbreviation: awayTeam.abbreviation,
      score: awayScore
    },
    home: {
      id: homeTeam.id,
      name: homeTeam.name,
      abbreviation: homeTeam.abbreviation,
      score: homeScore
    },
    winner: {
      id: winnerTeam?.id ?? null,
      name: winnerTeam?.name ?? null,
      abbreviation: winnerTeam?.abbreviation ?? null
    },
    loser: {
      id: loserTeam?.id ?? null,
      name: loserTeam?.name ?? null,
      abbreviation: loserTeam?.abbreviation ?? null
    }
  };
}

function starterSeasonEdge(homePitcherStats, awayPitcherStats) {
  if (!homePitcherStats && !awayPitcherStats) return 0;

  const homeEra = statEra(homePitcherStats);
  const awayEra = statEra(awayPitcherStats);
  const homeWhip = statWhip(homePitcherStats);
  const awayWhip = statWhip(awayPitcherStats);
  const homeKbb = kToBb(homePitcherStats);
  const awayKbb = kToBb(awayPitcherStats);
  const homeKMinusBb = pitchingKMinusBb(homePitcherStats);
  const awayKMinusBb = pitchingKMinusBb(awayPitcherStats);
  const homeHr9 = pitchingHr9(homePitcherStats);
  const awayHr9 = pitchingHr9(awayPitcherStats);

  return clamp(
    (awayEra - homeEra) / 2.4 +
      (awayWhip - homeWhip) / 0.6 +
      (homeKbb - awayKbb) / 4.0 +
      (homeKMinusBb - awayKMinusBb) / 0.16 +
      (awayHr9 - homeHr9) / 1.1,
    -1.6,
    1.6
  );
}

// Last-N starts edge from real gameLog rows (already fetched for display).
// Season ERA alone is slow to reflect current stuff/command; recent form is
// the actionable SP signal when both sides have enough IP.
function starterRecentEdge(homeRecent, awayRecent) {
  const homeIp = toNumber(homeRecent?.innings, 0);
  const awayIp = toNumber(awayRecent?.innings, 0);
  if (homeIp < 6 || awayIp < 6) return 0;

  const homeEra = toNumber(homeRecent.era, DEFAULTS.era);
  const awayEra = toNumber(awayRecent.era, DEFAULTS.era);
  const homeWhip = toNumber(homeRecent.whip, DEFAULTS.whip);
  const awayWhip = toNumber(awayRecent.whip, DEFAULTS.whip);
  const homeKbb =
    toNumber(homeRecent.strikeouts, 0) / Math.max(1, toNumber(homeRecent.walks, 0));
  const awayKbb =
    toNumber(awayRecent.strikeouts, 0) / Math.max(1, toNumber(awayRecent.walks, 0));
  const homeHr9 = homeIp > 0 ? (toNumber(homeRecent.homeRuns, 0) * 9) / homeIp : DEFAULTS.hr9;
  const awayHr9 = awayIp > 0 ? (toNumber(awayRecent.homeRuns, 0) * 9) / awayIp : DEFAULTS.hr9;

  const raw =
    (awayEra - homeEra) / 2.6 +
    (awayWhip - homeWhip) / 0.65 +
    (homeKbb - awayKbb) / 4.5 +
    (awayHr9 - homeHr9) / 1.2;
  const sampleWeight = clamp(Math.min(homeIp, awayIp) / 18, 0.35, 1);
  return clamp(raw * sampleWeight, -1.2, 1.2);
}

function starterEdge(homePitcherStats, awayPitcherStats, homeRecent = null, awayRecent = null) {
  const season = starterSeasonEdge(homePitcherStats, awayPitcherStats);
  const recent = starterRecentEdge(homeRecent, awayRecent);
  if (!homePitcherStats && !awayPitcherStats && recent === 0) return 0;
  // When recent form is available, give it real weight — season stats alone
  // produced a flat ~55% ceiling because SP edge was mostly lagging averages.
  if (recent === 0) return season;
  return clamp(season * 0.55 + recent * 0.45, -1.6, 1.6);
}

function createReasons({
  home,
  away,
  homeProfile,
  awayProfile,
  homePitcherStats,
  awayPitcherStats,
  homeStarter,
  awayStarter,
  homePitcherRecent = null,
  awayPitcherRecent = null,
  homeRolling = null,
  awayRolling = null,
  probHome,
  homeLineup,
  awayLineup,
  modelBreakdown
}) {
  const winner = probHome >= 50 ? home : away;
  const loser = probHome >= 50 ? away : home;
  const winnerProfile = probHome >= 50 ? homeProfile : awayProfile;
  const loserProfile = probHome >= 50 ? awayProfile : homeProfile;
  const winnerPitcherStats = probHome >= 50 ? homePitcherStats : awayPitcherStats;
  const loserPitcherStats = probHome >= 50 ? awayPitcherStats : homePitcherStats;
  const winnerStarter = probHome >= 50 ? homeStarter : awayStarter;
  const loserStarter = probHome >= 50 ? awayStarter : homeStarter;
  const winnerRecent = probHome >= 50 ? homePitcherRecent : awayPitcherRecent;
  const loserRecent = probHome >= 50 ? awayPitcherRecent : homePitcherRecent;
  const winnerRolling = probHome >= 50 ? homeRolling : awayRolling;
  const loserRolling = probHome >= 50 ? awayRolling : homeRolling;

  const reasons = [];
  const winnerRpg = rpg(winnerProfile?.hitting);
  const loserRpg = rpg(loserProfile?.hitting);
  const winnerOps = statOps(winnerProfile?.hitting);
  const loserOps = statOps(loserProfile?.hitting);
  const winnerIso = statIso(winnerProfile?.hittingAdvanced);
  const loserIso = statIso(loserProfile?.hittingAdvanced);
  const winnerKRate = battingKRate(winnerProfile?.hittingAdvanced);
  const loserKRate = battingKRate(loserProfile?.hittingAdvanced);
  const winnerBbRate = battingBbRate(winnerProfile?.hittingAdvanced);
  const loserBbRate = battingBbRate(loserProfile?.hittingAdvanced);
  const winnerEra = statEra(winnerProfile?.pitching);
  const loserEra = statEra(loserProfile?.pitching);
  const winnerWhip = statWhip(winnerProfile?.pitching);
  const loserWhip = statWhip(loserProfile?.pitching);
  const winnerKMinusBb = pitchingKMinusBb(winnerProfile?.pitchingAdvanced);
  const loserKMinusBb = pitchingKMinusBb(loserProfile?.pitchingAdvanced);
  const winnerHr9 = pitchingHr9(winnerProfile?.pitchingAdvanced);
  const loserHr9 = pitchingHr9(loserProfile?.pitchingAdvanced);
  const winnerSpEra = statEra(winnerPitcherStats);
  const loserSpEra = statEra(loserPitcherStats);
  const winnerSpWhip = statWhip(winnerPitcherStats);
  const loserSpWhip = statWhip(loserPitcherStats);
  const winnerSpKbb = kToBb(winnerPitcherStats);
  const loserSpKbb = kToBb(loserPitcherStats);
  const lineupEdge = toNumber(modelBreakdown?.lineupEdge, 0);
  const bullpenEdge = toNumber(modelBreakdown?.bullpenEdge, 0);
  const recordContextEdge = toNumber(modelBreakdown?.recordContextEdge, 0);
  const matchupEdge = toNumber(modelBreakdown?.matchupEdge, 0);
  const starterRecentEdgeValue = toNumber(modelBreakdown?.starterRecentEdge, 0);
  const winnerLineup = probHome >= 50 ? homeLineup : awayLineup;
  const loserLineup = probHome >= 50 ? awayLineup : homeLineup;

  if (
    winnerPitcherStats &&
    loserPitcherStats &&
    (winnerSpEra <= loserSpEra - 0.45 ||
      winnerSpWhip <= loserSpWhip - 0.12 ||
      winnerSpKbb >= loserSpKbb + 0.5)
  ) {
    reasons.push(
      `SP season: ${winnerStarter?.fullName || winner.name} ERA ${safeFixed(winnerSpEra)}, WHIP ${safeFixed(winnerSpWhip)} vs ${loserStarter?.fullName || loser.name} ERA ${safeFixed(loserSpEra)}, WHIP ${safeFixed(loserSpWhip)}.`
    );
  }

  if (
    winnerRecent?.games >= 2 &&
    loserRecent?.games >= 2 &&
    (
      Math.abs(starterRecentEdgeValue) >= 0.08 ||
      toNumber(winnerRecent.era, 99) <= toNumber(loserRecent.era, 99) - 0.6 ||
      toNumber(winnerRecent.whip, 99) <= toNumber(loserRecent.whip, 99) - 0.15
    )
  ) {
    reasons.push(
      `SP recent (last ${winnerRecent.games}/${loserRecent.games}): ${winnerStarter?.fullName || winner.name} ERA ${safeFixed(winnerRecent.era)}, WHIP ${safeFixed(winnerRecent.whip)} vs ${loserStarter?.fullName || loser.name} ERA ${safeFixed(loserRecent.era)}, WHIP ${safeFixed(loserRecent.whip)}.`
    );
  }

  if (
    winnerRolling?.hitting &&
    loserRolling?.hitting &&
    toNumber(winnerRolling.games, 0) >= 8 &&
    toNumber(loserRolling.games, 0) >= 8
  ) {
    const wRpg = rpg(winnerRolling.hitting);
    const lRpg = rpg(loserRolling.hitting);
    const wOps = statOps(winnerRolling.hitting);
    const lOps = statOps(loserRolling.hitting);
    if (wRpg >= lRpg + 0.35 || wOps >= lOps + 0.04) {
      reasons.push(
        `L21 form: ${winner.name} ${safeFixed(wRpg, 2)} R/G, OPS ${safeFixed(wOps, 3)} (n=${winnerRolling.games}) vs ${loser.name} ${safeFixed(lRpg, 2)} R/G, OPS ${safeFixed(lOps, 3)} (n=${loserRolling.games}).`
      );
    }
  }

  if (
    (winner.id === home.id && lineupEdge >= 0.035) ||
    (winner.id === away.id && lineupEdge <= -0.035)
  ) {
    const lineupStatus = winnerLineup?.confirmed
      ? `confirmed ${winnerLineup.count}/9`
      : winnerLineup?.count > 0
        ? `partial ${winnerLineup.count}/9`
        : 'lineup belum lengkap';
    const top = winnerLineup?.topFive?.slice(0, 3)?.length
      ? ` top ${winnerLineup.topFive.slice(0, 3).join(', ')}`
      : '';
    const loserStatus = loserLineup?.confirmed
      ? `vs ${loserLineup.count}/9 confirmed`
      : loserLineup?.count > 0
        ? `vs partial ${loserLineup.count}/9`
        : 'vs lineup lawan belum lengkap';
    reasons.push(`Lineup edge: ${winner.name} ${lineupStatus}${top}; ${loserStatus}.`);
  }

  if (
    winnerRpg >= loserRpg + 0.25 ||
    winnerOps >= loserOps + 0.025 ||
    winnerIso >= loserIso + 0.025 ||
    winnerBbRate >= loserBbRate + 0.02 ||
    winnerKRate <= loserKRate - 0.03
  ) {
    reasons.push(
      `Offense edge: ${winner.name} ${safeFixed(winnerRpg, 2)} R/G, OPS ${safeFixed(winnerOps, 3)}, ISO ${safeFixed(winnerIso, 3)} vs ${loser.name} ${safeFixed(loserRpg, 2)} R/G, OPS ${safeFixed(loserOps, 3)}, ISO ${safeFixed(loserIso, 3)}.`
    );
  }

  if (
    winnerEra <= loserEra - 0.25 ||
    winnerWhip <= loserWhip - 0.08 ||
    winnerKMinusBb >= loserKMinusBb + 0.025 ||
    winnerHr9 <= loserHr9 - 0.2
  ) {
    reasons.push(
      `Pitching team lebih kuat: ERA ${safeFixed(winnerEra)}, WHIP ${safeFixed(winnerWhip)}, K-BB ${ratePct(winnerKMinusBb)} vs ERA ${safeFixed(loserEra)}, WHIP ${safeFixed(loserWhip)}, K-BB ${ratePct(loserKMinusBb)}.`
    );
  }

  const winnerPct = leagueRecordPct(winner.record);
  const loserPct = leagueRecordPct(loser.record);
  if (winnerPct >= loserPct + 0.05) {
    reasons.push(`Form season: win% ${safeFixed(winnerPct, 3)} vs ${safeFixed(loserPct, 3)}.`);
  }

  if (winner.id === home.id) {
    reasons.push('Home field memberi edge kecil.');
  }

  if (modelBreakdown?.recordDominated) {
    reasons.push('Record/H2H dibatasi: matchup hari ini belum cukup kuat, jadi confidence harus konservatif.');
  } else if (Math.abs(matchupEdge) >= Math.abs(recordContextEdge) + 0.08) {
    reasons.push('Pick lebih didorong matchup hari ini daripada record/H2H series.');
  }

  if (
    (winner.id === home.id && bullpenEdge >= 0.045) ||
    (winner.id === away.id && bullpenEdge <= -0.045)
  ) {
    reasons.push(`Bullpen availability: bullpen lawan lebih lelah, memberi edge late-game ke ${winner.name}.`);
  }

  if (reasons.length === 0) {
    reasons.push('Edge tipis dari kombinasi record, offense, pitching, dan venue.');
  }

  return reasons.slice(0, 3);
}

function standingContext(team, standing, venueSplitType) {
  const lastTen = splitRecord(standing, 'lastTen');
  const venue = splitRecord(standing, venueSplitType);
  const xRecord = expectedRecord(standing);
  const streak = standing?.streak?.streakCode || '-';

  return [
    `${team.abbreviation || team.name} ${recordText(standing?.leagueRecord)}`,
    `L10 ${recordText(lastTen)}`,
    `${venueSplitType === 'home' ? 'home' : 'road'} ${recordText(venue)}`,
    `RD ${signed(standing?.runDifferential)}`,
    `xW-L ${recordText(xRecord)}`,
    streak
  ].join(', ');
}

function advancedContext(team, profile) {
  return [
    `${team.abbreviation || team.name}`,
    `ISO ${safeFixed(statIso(profile?.hittingAdvanced), 3)}`,
    `K ${ratePct(battingKRate(profile?.hittingAdvanced))}`,
    `BB ${ratePct(battingBbRate(profile?.hittingAdvanced))}`,
    `Pit K-BB ${ratePct(pitchingKMinusBb(profile?.pitchingAdvanced))}`,
    `HR9 ${safeFixed(pitchingHr9(profile?.pitchingAdvanced), 2)}`
  ].join(' ');
}

function injuryCountLabel(team, injuries) {
  const label = team.abbreviation || team.name;
  const count = injuries.length;
  return count > 0 ? `${label} IL ${count}` : `${label} IL clear`;
}

function injuryDetailLines(team, injuries) {
  const label = team.abbreviation || team.name;
  if (!injuries.length) return [`${label}: tidak ada pemain 40-man roster yang berstatus injured.`];

  return injuries.map((injury) => {
    const note = injury.note ? ` - ${injury.note}` : '';
    return `${label}: ${injury.name} (${injury.position}, ${injury.status})${note}`;
  });
}

function referenceEdgeLabel(away, home, homeProbability) {
  const homeProb = Math.round(homeProbability);
  const awayProb = 100 - homeProb;
  return homeProb >= awayProb
    ? `${home.abbreviation || home.name} ${homeProb}%`
    : `${away.abbreviation || away.name} ${awayProb}%`;
}

function buildModelReferenceLines({
  away,
  home,
  awayPythagoreanPct,
  homePythagoreanPct,
  homeSeasonLog5,
  homePythagoreanLog5,
  homeRecentLog5,
  homeReferenceBlend
}) {
  const awayPythPct = Math.round(awayPythagoreanPct * 100);
  const homePythPct = Math.round(homePythagoreanPct * 100);
  const direction =
    homeReferenceBlend >= 0.5
      ? `${home.name} (${percent(homeReferenceBlend * 100)})`
      : `${away.name} (${percent((1 - homeReferenceBlend) * 100)})`;

  return [
    `Arah edge ML: ${direction}`,
    `Pythagorean strength: ${away.abbreviation || away.name} ${awayPythPct}% vs ${home.abbreviation || home.name} ${homePythPct}%.`,
    `Log5 season: ${referenceEdgeLabel(away, home, homeSeasonLog5 * 100)}.`,
    `Log5 Pythagorean: ${referenceEdgeLabel(away, home, homePythagoreanLog5 * 100)}.`,
    `Recent form Log5: ${referenceEdgeLabel(away, home, homeRecentLog5 * 100)}.`
  ];
}

function offenseRunAdjustment(profile) {
  const hitting = profile?.hitting;
  const advanced = profile?.hittingAdvanced;
  const rpgAdj = (rpg(hitting) - DEFAULTS.rpg) * 0.45;
  const opsAdj = (statOps(hitting) - DEFAULTS.ops) * 2.0;
  const isoAdj = (statIso(advanced) - DEFAULTS.iso) * 1.3;
  const bbAdj = (battingBbRate(advanced) - DEFAULTS.bbRate) * 1.4;
  const kAdj = (DEFAULTS.kRate - battingKRate(advanced)) * 0.9;
  return clamp(rpgAdj + opsAdj + isoAdj + bbAdj + kAdj, -1.2, 1.2);
}

function pitcherRunAdjustment(stats) {
  if (!stats) return 0;

  const eraAdj = (statEra(stats) - DEFAULTS.era) * 0.15;
  const whipAdj = (statWhip(stats) - DEFAULTS.whip) * 0.75;
  const hrAdj = (pitchingHr9(stats) - DEFAULTS.hr9) * 0.22;
  const kbbAdj = (DEFAULTS.kMinusBb - pitchingKMinusBb(stats)) * 1.2;
  return clamp(eraAdj + whipAdj + hrAdj + kbbAdj, -1.2, 1.2);
}

function bullpenRunAdjustment(bullpen) {
  if (!bullpen) return 0;

  const fatigue = Math.max(0, toNumber(bullpen.fatigueScore, 0) - 0.8) * 0.2;
  const b2b = toNumber(bullpen.backToBackRelievers, 0) * 0.04;
  const highPitch = toNumber(bullpen.highPitchRelievers, 0) * 0.03;
  return clamp(fatigue + b2b + highPitch, 0, 0.85);
}

function injuryRunAdjustment(injuries) {
  if (!Array.isArray(injuries) || injuries.length === 0) return 0;

  const hitterInjuries = injuries.filter((injury) => injury.position !== 'P').length;
  const pitcherInjuries = injuries.length - hitterInjuries;
  return clamp(-(hitterInjuries * 0.08 + pitcherInjuries * 0.02), -0.7, 0);
}

function recentRunAdjustment(teamStanding, opponentStanding) {
  return clamp((runDiffPerGame(teamStanding) - runDiffPerGame(opponentStanding)) * 0.08, -0.35, 0.35);
}

function parseWeatherNumber(value) {
  const parsed = String(value || '').match(/-?\d+(\.\d+)?/);
  return parsed ? Number.parseFloat(parsed[0]) : null;
}

function weatherRunAdjustment(weather) {
  if (!weather) return 0;

  const temp = parseWeatherNumber(weather.temp || weather.temperature);
  const weatherText = JSON.stringify(weather).toLowerCase();
  const windText = String(weather.wind || weather.windDirection || '').toLowerCase();
  const windSpeed = parseWeatherNumber(windText) || 0;
  const tempAdj = temp === null ? 0 : clamp((temp - 70) * 0.015, -0.35, 0.35);
  const windAdj = windText.includes('out')
    ? clamp(windSpeed * 0.025, 0, 0.4)
    : windText.includes('in')
      ? -clamp(windSpeed * 0.025, 0, 0.4)
      : 0;
  const roofMultiplier =
    weatherText.includes('roof closed') || weatherText.includes('closed roof') || weatherText.includes('dome')
      ? 0.2
      : 1;
  return clamp((tempAdj + windAdj) * roofMultiplier, -0.55, 0.55);
}

function parkFactorContext(homeTeam) {
  const baseline = PARK_FACTOR_BASELINES.get(homeTeam?.id) || {
    runFactor: 1,
    homeRunFactor: 1,
    label: homeTeam?.name || 'Neutral park'
  };
  const runAdjustment = clamp(
    (baseline.runFactor - 1) * 3.8 + (baseline.homeRunFactor - 1) * 0.9,
    -0.75,
    0.85
  );

  return {
    ...baseline,
    runAdjustment,
    runFactorPct: Math.round(baseline.runFactor * 100),
    homeRunFactorPct: Math.round(baseline.homeRunFactor * 100)
  };
}

function lineupRunAdjustment(lineup, injuries) {
  if (!lineup) return 0;

  const hitterInjuries = Array.isArray(injuries)
    ? injuries.filter((injury) => injury.position !== 'P').length
    : 0;

  if (lineup.confirmed) {
    return clamp(0.06 - hitterInjuries * 0.025, -0.2, 0.08);
  }

  if (lineup.count > 0) {
    return clamp(-0.04 - Math.max(0, 9 - lineup.count) * 0.025, -0.25, 0.02);
  }

  return 0;
}

function lineupWinEdge(homeLineup, awayLineup, homeInjuries, awayInjuries) {
  const homeQuality = toNumber(homeLineup?.qualityScore, 0);
  const awayQuality = toNumber(awayLineup?.qualityScore, 0);
  const homeAvailability = lineupRunAdjustment(homeLineup, homeInjuries);
  const awayAvailability = lineupRunAdjustment(awayLineup, awayInjuries);
  return clamp(homeQuality - awayQuality + (homeAvailability - awayAvailability) * 0.45, -0.18, 0.18);
}

// Both teams have publicly posted full nine-hitter lineups. Confirmed lineups
// remove a real source of uncertainty (replacement-level fill-ins) so the
// model's existing matchup edge should count slightly more — but only when
// directional info is already there. We expose this as a small multiplier,
// never as a free bump to either side's win probability.
export function bothLineupsConfirmed(lineups) {
  const away = lineups?.away;
  const home = lineups?.home;
  return Boolean(
    away?.confirmed && home?.confirmed && (away?.count || 0) >= 9 && (home?.count || 0) >= 9
  );
}

function bullpenAvailabilityEdge(homeBullpen, awayBullpen) {
  const homeFatigue = toNumber(homeBullpen?.fatigueScore, 0);
  const awayFatigue = toNumber(awayBullpen?.fatigueScore, 0);
  const homeB2b = toNumber(homeBullpen?.backToBackRelievers, 0);
  const awayB2b = toNumber(awayBullpen?.backToBackRelievers, 0);
  const homeHighPitch = toNumber(homeBullpen?.highPitchRelievers, 0);
  const awayHighPitch = toNumber(awayBullpen?.highPitchRelievers, 0);
  return clamp(
    (awayFatigue - homeFatigue) * 0.075 +
      (awayB2b - homeB2b) * 0.025 +
      (awayHighPitch - homeHighPitch) * 0.018,
    -0.18,
    0.18
  );
}

function edgeTeamLabel(edge, away, home) {
  if (edge > 0.015) return home.abbreviation || home.name;
  if (edge < -0.015) return away.abbreviation || away.name;
  return 'even';
}

function edgeComponentText(label, value, away, home) {
  const team = edgeTeamLabel(value, away, home);
  const magnitude = Math.abs(toNumber(value, 0)).toFixed(2);
  return `${label} ${team} ${magnitude}`;
}

function lineupStatusLine(team, lineup) {
  const label = team.abbreviation || team.name;
  if (!lineup) return `${label}: lineup belum tersedia`;
  if (lineup.confirmed) {
    const topNames = lineup.topFive?.slice(0, 3) || [];
    const top = topNames.length ? ` top: ${topNames.join(', ')}` : '';
    return `${label}: confirmed ${lineup.count}/9${top}`;
  }
  if (lineup.count > 0) return `${label}: partial ${lineup.count}/9`;
  return `${label}: lineup belum tersedia`;
}

function predictGame(
  game,
  teamStats,
  standings,
  pitcherStats,
  pitcherDetails,
  pitcherRecentStarts,
  bullpenProfiles,
  scheduleFatigueProfiles,
  headToHead,
  injuryProfiles,
  lineupProfiles,
  modelMemory,
  rollingTeamStats = new Map(),
  predictionTimestampUtc = null
) {
  // All deterministic probability math lives in the pure canonical core
  // (src/core/prediction_core.js). This wrapper injects the externally-sourced
  // inputs the pure core is forbidden from reading itself: evolution controls
  // (filesystem), the calibration function (artifact), park factor baselines,
  // and the wall-clock `now` used only for prediction tiering.
  const evolutionControls = loadEvolutionControls();
  const decisionTimestampUtc = predictionTimestampUtc || new Date().toISOString();
  const core = predictGameMoneylineCore({
    game,
    teamStats,
    standings,
    pitcherStats,
    pitcherDetails,
    pitcherRecentStarts,
    bullpenProfiles,
    scheduleFatigueProfiles,
    headToHead,
    injuryProfiles,
    lineupProfiles,
    modelMemory,
    rollingTeamStats,
    evolutionControls,
    calibratePercent,
    parkFactorBaselines: PARK_FACTOR_BASELINES,
    nowMs: decisionTimestampUtc,
    moneylineWeightMultiplierFn: moneylineWeightMultiplier,
    defaultBullpenProfileFn: (teamId) =>
      finalizeBullpenProfile({
        teamId,
        games: 0,
        bullpenPitches: 0,
        bullpenOuts: 0,
        relieverAppearances: 0,
        relieverDates: new Map(),
        highPitchRelievers: 0
      })
  });

  const {
    awayTeam,
    homeTeam,
    awayProfile,
    homeProfile,
    awayRolling,
    homeRolling,
    awayStanding,
    homeStanding,
    awayStarter,
    homeStarter,
    awayOpenerSituation,
    homeOpenerSituation,
    effectiveAwayPitcherStats,
    effectiveHomePitcherStats,
    awayPitcherStats,
    homePitcherStats,
    awayPitcherRecent,
    homePitcherRecent,
    awayBullpen,
    homeBullpen,
    awayScheduleFatigue,
    homeScheduleFatigue,
    awayPitcherRest,
    homePitcherRest,
    awayInjuries,
    homeInjuries,
    awayLineup,
    homeLineup,
    matchupMemory,
    awayPythagoreanPct,
    homePythagoreanPct,
    homeSeasonLog5,
    homePythagoreanLog5,
    homeRecentLog5,
    homeReferenceBlend,
    awayMemoryBias,
    homeMemoryBias,
    fatigueEdge,
    offenseBlend,
    starterWeightMultiplier,
    spRecentEdgeRaw,
    bothConfirmed,
    confirmationEdge,
    modelBreakdown
  } = core;
  const homeProbability = core.calibrated.homeProbability;
  const awayProbability = core.calibrated.awayProbability;
  const rawHomeProbability = core.raw.homeProbability;
  const rawAwayProbability = core.raw.awayProbability;
  const gameDateYmd = core.gameDateYmd;

  modelBreakdown.sharpMoney = detectSharpMoneySignal(
    homeProbability >= awayProbability ? homeTeam.name : awayTeam.name,
    null,
    null
  );
  modelBreakdown.modelVersion = PREDICTION_CORE_MODEL_VERSION;

  const home = {
    id: homeTeam.id,
    name: homeTeam.name,
    abbreviation: homeTeam.abbreviation,
    record: homeStanding?.leagueRecord || game.teams.home.leagueRecord,
    starter: homeStarter,
    starterLine: homeOpenerSituation.isOpener
      ? 'Bulk pitcher TBD'
      : pitcherLabel(homeStarter, homePitcherStats),
    starterEra: homePitcherStats ? statEra(homePitcherStats) : null,
    openerSituation: homeOpenerSituation,
    winProbability: homeProbability,
    winProbabilityRaw: rawHomeProbability,
    pureModelProbability: homeProbability,
    marketInformedProbability: null
  };
  const away = {
    id: awayTeam.id,
    name: awayTeam.name,
    abbreviation: awayTeam.abbreviation,
    record: awayStanding?.leagueRecord || game.teams.away.leagueRecord,
    starter: awayStarter,
    starterLine: awayOpenerSituation.isOpener
      ? 'Bulk pitcher TBD'
      : pitcherLabel(awayStarter, awayPitcherStats),
    starterEra: awayPitcherStats ? statEra(awayPitcherStats) : null,
    openerSituation: awayOpenerSituation,
    winProbability: awayProbability,
    winProbabilityRaw: rawAwayProbability,
    pureModelProbability: awayProbability,
    marketInformedProbability: null
  };

  const reasons = createReasons({
    home,
    away,
    homeProfile,
    awayProfile,
    homePitcherStats: effectiveHomePitcherStats,
    awayPitcherStats: effectiveAwayPitcherStats,
    homeStarter,
    awayStarter,
    homePitcherRecent,
    awayPitcherRecent,
    homeRolling,
    awayRolling,
    probHome: homeProbability,
    homeLineup,
    awayLineup,
    modelBreakdown
  });
  const modelReferenceLines = buildModelReferenceLines({
    away,
    home,
    awayPythagoreanPct,
    homePythagoreanPct,
    homeSeasonLog5,
    homePythagoreanLog5,
    homeRecentLog5,
    homeReferenceBlend
  });
  const awayPitcherRecentLine = awayOpenerSituation.isOpener
    ? 'Bulk pitcher TBD'
    : awayPitcherRecent?.line || 'recent starts unavailable';
  const homePitcherRecentLine = homeOpenerSituation.isOpener
    ? 'Bulk pitcher TBD'
    : homePitcherRecent?.line || 'recent starts unavailable';

  return {
    gamePk: game.gamePk,
    status: game.status?.detailedState || 'Scheduled',
    start: formatGameTime(game.gameDate, MLB_TIMEZONE),
    startTime: game.gameDate || null,
    venue: game.venue?.name || 'TBD',
    // Surface the raw weather payload and computed park-factor context so the
    // dashboard quality report can honestly reflect which inputs were present
    // (previously it read weather_detail/park_detail, fields that never existed).
    weather: game.weather || null,
    parkFactor: parkFactorContext(homeTeam),
    away,
    home,
    contextLine: `${standingContext(away, awayStanding, 'away')} | ${standingContext(home, homeStanding, 'home')}`,
    advancedLine: `${advancedContext(away, awayProfile)} | ${advancedContext(home, homeProfile)}`,
    matchupSplitLine: `${matchupSplitLine(away, awayStanding, homeStarter, 'away')} | ${matchupSplitLine(home, homeStanding, awayStarter, 'home')}`,
    pitcherRecentLine: `${away.abbreviation || away.name} SP ${awayPitcherRecentLine} | ${home.abbreviation || home.name} SP ${homePitcherRecentLine}`,
    rollingFormLine: `${rollingFormLine(away, awayRolling)} | ${rollingFormLine(home, homeRolling)}`,
    bullpenLine: `${away.abbreviation || away.name} bullpen ${awayBullpen.line} | ${home.abbreviation || home.name} bullpen ${homeBullpen.line}`,
    fatigueLines: fatigueFlagLines(away, home, awayScheduleFatigue, homeScheduleFatigue, awayPitcherRest, homePitcherRest),
    injuryLine: `${injuryCountLabel(away, awayInjuries)} | ${injuryCountLabel(home, homeInjuries)}`,
    injuryDetailLines: [
      ...injuryDetailLines(away, awayInjuries),
      ...injuryDetailLines(home, homeInjuries)
    ],
    lineupLine: `${lineupStatusLine(away, awayLineup)} | ${lineupStatusLine(home, homeLineup)}`,
    lineups: {
      away: awayLineup,
      home: homeLineup
    },
    injuries: {
      away: awayInjuries,
      home: homeInjuries
    },
    rollingForm: {
      away: awayRolling,
      home: homeRolling,
      windowDays: ROLLING_FORM_DAYS
    },
    modelReferenceLine: modelReferenceLines.join(' | '),
    modelReferenceLines,
    modelBreakdownLine: [
      edgeComponentText('matchup', modelBreakdown.matchupEdge, away, home),
      edgeComponentText('record/H2H', modelBreakdown.recordContextEdge, away, home),
      edgeComponentText('SP', modelBreakdown.starterEdge, away, home),
      Math.abs(spRecentEdgeRaw) >= 0.04
        ? edgeComponentText('SP recent', spRecentEdgeRaw * 0.42 * starterWeightMultiplier, away, home)
        : null,
      offenseBlend.rollingWeight >= 0.15
        ? edgeComponentText('L21 form', offenseBlend.rollingEdge * 0.32, away, home)
        : null,
      edgeComponentText('lineup', modelBreakdown.lineupEdge, away, home),
      edgeComponentText('bullpen', modelBreakdown.bullpenEdge, away, home),
      bothConfirmed && Math.abs(confirmationEdge) >= 0.005
        ? edgeComponentText('lineup✓', confirmationEdge, away, home)
        : null
    ].filter(Boolean).join(' | '),
    modelBreakdown,
    modelReference: {
      awayPythagoreanPct: Math.round(awayPythagoreanPct * 100),
      homePythagoreanPct: Math.round(homePythagoreanPct * 100),
      homeSeasonLog5: Math.round(homeSeasonLog5 * 100),
      homePythagoreanLog5: Math.round(homePythagoreanLog5 * 100),
      homeRecentLog5: Math.round(homeRecentLog5 * 100),
      homeReferenceBlend: Math.round(homeReferenceBlend * 100)
    },
    pitcherRecent: {
      away: awayPitcherRecent,
      home: homePitcherRecent
    },
    bullpen: {
      away: awayBullpen,
      home: homeBullpen
    },
    scheduleFatigue: {
      away: awayScheduleFatigue,
      home: homeScheduleFatigue,
      pitcherRest: {
        away: awayPitcherRest,
        home: homePitcherRest
      },
      edge: fatigueEdge
    },
    memoryAdjustment: {
      away: awayMemoryBias,
      home: homeMemoryBias,
      matchup: matchupMemory.edge,
      note: matchupMemory.note
    },
    matchupMemory,
    headToHead,
    winner: homeProbability >= awayProbability ? home : away,
    reasons
  };
}

export const __mlbTestInternals = {
  actualStarterForSide,
  starterEdge,
  starterRecentEdge,
  starterSeasonEdge,
  blendedTeamOffenseEdge,
  blendedTeamPreventionEdge,
  rollingFormWindow,
  getRollingTeamStatMap,
  moneylineOddsAgeMinutes,
  moneylineOddsFreshnessReason,
  determinePredictionTier,
  filterSplitsBeforeDate,
  devigMoneylinePercent,
  moneylineBooksAreSame,
  moneylineValueOption,
  MARKET_BLEND_WEIGHT,
  ROLLING_FORM_DAYS
};

export async function getMlbPredictions(dateYmd = dateInTimezone('Asia/Jakarta'), modelMemory = {}) {
  const season = seasonFromDate(dateYmd);
  const games = await fetchSchedule(dateYmd);
  if (games.length === 0) return [];

  const teamIds = [
    ...new Set(games.flatMap((game) => [game.teams.away.team.id, game.teams.home.team.id]))
  ];

  // Each fetch falls back to an empty Map so one transient API failure degrades
  // that single signal (the model has DEFAULTS for missing data) instead of
  // throwing out of getMlbPredictions and zeroing the entire slate.
  const warnFetch = (label) => (error) => {
    console.warn(`getMlbPredictions: ${label} fetch failed, using empty data:`, error.message);
    return new Map();
  };
  const [teamStats, rollingTeamStats, standings, bullpenProfiles, scheduleFatigueProfiles, injuryProfiles] = await Promise.all([
    fetchTeamStats(season, dateYmd).catch(warnFetch('teamStats')),
    fetchRollingTeamStats(season, dateYmd).catch(warnFetch('rollingTeamStats')),
    fetchStandings(season, dateYmd).catch(warnFetch('standings')),
    fetchBullpenProfiles(teamIds, dateYmd).catch(warnFetch('bullpenProfiles')),
    fetchScheduleFatigueProfiles(teamIds, dateYmd).catch(warnFetch('scheduleFatigueProfiles')),
    fetchInjuryProfiles(teamIds, dateYmd, season).catch(warnFetch('injuryProfiles'))
  ]);
  const probablePitcherIds = [
    ...new Set(
      games
        .flatMap((game) => [
          game.teams.away.probablePitcher?.id,
          game.teams.home.probablePitcher?.id
        ])
        .filter(Boolean)
    )
  ];

  const pitcherStats = new Map();
  const pitcherDetails = new Map();
  const pitcherRecentStarts = new Map();
  await Promise.all(
    probablePitcherIds.map(async (personId) => {
      try {
        pitcherDetails.set(personId, await fetchPerson(personId));
      } catch {
        pitcherDetails.set(personId, null);
      }

      try {
        pitcherStats.set(personId, await fetchPitcherStats(personId, season, dateYmd));
      } catch {
        pitcherStats.set(personId, null);
      }

      try {
        pitcherRecentStarts.set(
          personId,
          await fetchPitcherRecentStarts(personId, season, 5, dateYmd)
        );
      } catch {
        pitcherRecentStarts.set(personId, null);
      }
    })
  );

  const headToHeadStats = new Map();
  await Promise.all(
    games.map(async (game) => {
      try {
        headToHeadStats.set(game.gamePk, await fetchHeadToHead(game, season, dateYmd));
      } catch {
        headToHeadStats.set(game.gamePk, {
          games: 0,
          awayWins: 0,
          homeWins: 0,
          awayProbability: 50,
          homeProbability: 50
        });
      }
    })
  );

  const lineupProfiles = new Map();
  await Promise.all(
    games.map(async (game) => {
      try {
        lineupProfiles.set(game.gamePk, await fetchGameLineupProfile(game.gamePk));
      } catch {
        lineupProfiles.set(game.gamePk, { away: null, home: null });
      }
    })
  );

  return games.map((game) => {
    const predictionTimestampUtc = new Date().toISOString();
    const prediction = predictGame(
      game,
      teamStats,
      standings,
      pitcherStats,
      pitcherDetails,
      pitcherRecentStarts,
      bullpenProfiles,
      scheduleFatigueProfiles,
      headToHeadStats.get(game.gamePk),
      injuryProfiles,
      lineupProfiles.get(game.gamePk),
      modelMemory,
      rollingTeamStats,
      predictionTimestampUtc
    );
    // Freeze the raw core inputs so this live prediction can be recomputed by
    // snapshot replay (not just projected). Plain JSON; Maps serialized.
    prediction.coreInputs = buildCoreInputsSnapshot({
      game,
      teamStats,
      standings,
      pitcherStats,
      pitcherDetails,
      pitcherRecentStarts,
      bullpenProfiles,
      scheduleFatigueProfiles,
      headToHead: headToHeadStats.get(game.gamePk),
      injuryProfiles,
      lineupProfiles: lineupProfiles.get(game.gamePk) || { away: null, home: null },
      modelMemory,
      rollingTeamStats,
      evolutionControls: loadEvolutionControls(),
      parkFactorBaselines: PARK_FACTOR_BASELINES
    });
    prediction.predictionTimestampUtc = predictionTimestampUtc;
    return prediction;
  });
}

export async function getMlbScheduleChoices(dateYmd = dateInTimezone('Asia/Jakarta')) {
  const games = await fetchSchedule(dateYmd);

  return games.map((game) => ({
    gamePk: game.gamePk,
    status: game.status?.detailedState || 'Scheduled',
    abstractGameState: game.status?.abstractGameState || '',
    start: formatGameTime(game.gameDate, MLB_TIMEZONE),
    startTime: game.gameDate || null,
    venue: game.venue?.name || 'TBD',
    away: {
      id: game.teams.away.team.id,
      name: game.teams.away.team.name,
      abbreviation: game.teams.away.team.abbreviation
    },
    home: {
      id: game.teams.home.team.id,
      name: game.teams.home.team.name,
      abbreviation: game.teams.home.team.abbreviation
    },
    probablePitchers: {
      away: game.teams.away.probablePitcher?.fullName || 'TBD',
      home: game.teams.home.probablePitcher?.fullName || 'TBD'
    }
  }));
}

export async function getFinalGameResults(dateYmd = dateInTimezone('Asia/Jakarta')) {
  const games = await fetchSchedule(dateYmd);

  return games
    .filter((game) => game.status?.abstractGameState === 'Final')
    .filter((game) =>
      Number.isFinite(toNumber(game.teams?.away?.score, Number.NaN)) &&
      Number.isFinite(toNumber(game.teams?.home?.score, Number.NaN))
    )
    .map((game) => finalGameResult(game, dateYmd));
}

export function formatPredictions(
  dateYmd,
  predictions,
  { maxGames = 8, teamFilter = '', includeAdvanced = true, includeNews = false } = {}
) {
  const normalizedFilter = teamFilter.toLowerCase();
  const filtered = normalizedFilter
    ? predictions.filter((item) =>
        [item.away.name, item.home.name, item.away.abbreviation, item.home.abbreviation]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(normalizedFilter))
      )
    : predictions;

  if (filtered.length === 0) {
    return normalizedFilter
      ? [uiTitle('⚾', 'MLB Pre-game Alert'), uiKV('📅', 'Tanggal', dateYmd), '', uiBullet('⚠️', `Tidak ada game MLB untuk filter "${teamFilter}".`)].join('\n')
      : [uiTitle('⚾', 'MLB Pre-game Alert'), uiKV('📅', 'Tanggal', dateYmd), '', uiBullet('⚠️', 'Tidak ada game MLB pada tanggal ini.')].join('\n');
  }

  const shown = filtered.slice(0, maxGames);
  const lines = [[uiTitle('⚾', 'MLB Pre-game Alert'), uiKV('📅', 'Tanggal', dateYmd)].join('\n'), GAME_SEPARATOR];

  if (!includeAdvanced) {
    for (const item of shown) {
      lines.push(compactPredictionBlock(item));
      lines.push(SECTION_SEPARATOR);
    }

    if (filtered.length > shown.length) {
      lines.push(uiBullet('➕', `${filtered.length - shown.length} game lain | pakai /deep untuk semua statistik detail.`));
    }

    lines.push(uiBullet('⚠️', 'Probabilitas adalah estimasi model, bukan kepastian.'));
    return lines.join('\n\n');
  }

  for (const item of shown) {
    const displayProb = displayedProbabilities(item);
    const pick = agentPick(item);
    const agentActive = Boolean(item.agentAnalysis);
    const openerLines = openerAlertLines(item);
    const contextLines = [
      ...splitInfoLine(item.contextLine),
      ...(item.matchupMemory?.games > 0 ? [uiKV('•', 'Memory matchup', item.matchupMemory.note)] : [])
    ];
    const splitLines = splitInfoLine(item.matchupSplitLine);
    const bullpenLines = splitInfoLine(item.bullpenLine);
    const fatigueLines = item.fatigueLines?.length
      ? item.fatigueLines.map((line) => uiBullet('•', line))
      : [];
    const pitcherRecentLines = splitInfoLine(item.pitcherRecentLine);
    const advancedLines = splitInfoLine(item.advancedLine);
    const modelReferenceLines = item.modelReferenceLines?.length
      ? item.modelReferenceLines.map((line) => uiBullet('•', line))
      : splitInfoLine(item.modelReferenceLine);
    const injuryLines = item.injuryDetailLines?.length
      ? item.injuryDetailLines.map((line) => uiBullet('•', line))
      : splitInfoLine(item.injuryLine);
    const newsLines = includeNews
      ? (item.newsContext?.articles || []).slice(0, 2).map((article) => {
          const published = article.publishedAt
            ? new Date(article.publishedAt).toISOString().slice(0, 16).replace('T', ' ')
            : 'waktu tidak tersedia';
          return uiBullet('•', `[${article.sourceName}] ${article.title} | ${published} UTC`);
        })
      : [];
    const h2hSummary =
      item.headToHead?.games > 0
        ? `${item.away.abbreviation || item.away.name} ${item.headToHead.awayWins}-${item.headToHead.homeWins} ${item.home.abbreviation || item.home.name}`
        : 'Belum ada final H2H musim ini';
    lines.push(
      [
        uiKV('🏟️', 'Matchup', `${item.away.name} @ ${item.home.name}`),
        uiKV('🕒', 'Waktu', item.start),
        uiKV('📍', 'Stadium', item.venue),
        '',
        SECTION_SEPARATOR,
        uiSection('📊', 'Probabilitas'),
        agentActive
          ? uiKV('🤖', 'Agent', `${displayedWinProbText(item.away, displayProb.away)} | ${displayedWinProbText(item.home, displayProb.home)}`)
          : uiKV('📊', 'Model', `${winProbText(item.away)} | ${winProbText(item.home)}`),
        agentActive ? uiKV('📐', 'Baseline', `${winProbText(item.away)} | ${winProbText(item.home)}`) : null,
        uiKV('🤝', 'H2H', h2hSummary),
        uiKV('🎯', 'H2H Prob', `${h2hProbText(item.away, item.headToHead?.awayProbability ?? 50)} | ${h2hProbText(item.home, item.headToHead?.homeProbability ?? 50)}`),
        item.modelBreakdownLine ? uiKV('🧮', 'Model source', item.modelBreakdownLine) : null,
        '',
        SECTION_SEPARATOR,
        uiKV('✅', `Pick ${agentActive ? 'Agent' : 'Model'}`, `${pick.name}${agentActive ? ` | ${item.agentAnalysis.confidence}` : ''}`),
        ...bettingSafetyLines(item, pick),
        ...moneylineDecisionLines(item),
        ...openerLines,
        ...lateUpdateLines(item),
        uiKV('🔥', 'SP', `${item.away.starterLine} vs ${item.home.starterLine}`),
        '',
        SECTION_SEPARATOR,
        uiSection('📌', 'Context'),
        ...contextLines,
        '',
        uiSection('⚾', 'Splits'),
        ...splitLines,
        '',
        uiSection('🧤', 'Bullpen'),
        ...bullpenLines,
        ...fatigueLines,
        '',
        uiSection('🏥', 'Injury Report'),
        ...injuryLines,
        '',
        // Always surface news risk flags when present (veto support), even if
        // full news section is off. Probability impact remains none.
        ...((item.newsContext?.newsRisk?.flags || []).length
          ? [
              uiSection('📰', 'News Risk'),
              ...item.newsContext.newsRisk.flags.slice(0, 4).map((f) =>
                uiBullet('•', `[${f.severity}] ${f.flag}${f.title ? `: ${f.title}` : ''}`)
              ),
              item.newsContext.newsRisk.veto
                ? uiKV('🛑', 'Veto', (item.newsContext.newsRisk.vetoReasons || []).join(' | '))
                : null,
              ''
            ]
          : []),
        ...(includeNews
          ? [
              uiSection('📰', 'External News'),
              ...(newsLines.length
                ? newsLines
                : [uiBullet('•', `Tidak ada artikel cocok (${item.newsContext?.status || 'unavailable'}).`)]),
              ''
            ]
          : []),
        ...(playerImpactLines(item).length
          ? [uiSection('🧩', 'Player Impact'), ...playerImpactLines(item), '']
          : []),
        uiSection('📈', 'SP Recent'),
        ...pitcherRecentLines,
        item.rollingFormLine ? '' : null,
        item.rollingFormLine ? uiSection('📉', 'Rolling L21') : null,
        ...(item.rollingFormLine ? splitInfoLine(item.rollingFormLine) : []),
        includeAdvanced ? '' : null,
        includeAdvanced ? uiSection('🔎', 'Advanced') : null,
        ...(includeAdvanced ? advancedLines : []),
        includeAdvanced ? '' : null,
        includeAdvanced ? uiSection('🧠', 'ML Reference') : null,
        ...(includeAdvanced ? modelReferenceLines : []),
        '',
        SECTION_SEPARATOR,
        agentActive ? uiSection('💡', 'Analisa Agent') : uiSection('💡', 'Alasan'),
        agentActive
          ? item.agentAnalysis.reasons.map((reason) => uiBullet('•', reason)).join('\n')
          : item.reasons.join(' '),
        agentActive ? uiKV('⚠️', 'Risk', item.agentAnalysis.risk) : null,
        agentActive ? uiKV('🧠', 'Memory', item.agentAnalysis.memoryNote) : null,
        '',
        SECTION_SEPARATOR,
      ]
        .filter((line) => line !== null)
        .join('\n')
    );
    lines.push(GAME_SEPARATOR);
  }

  if (filtered.length > shown.length) {
    lines.push(uiBullet('➕', `${filtered.length - shown.length} game lain | pakai /game TEAM untuk cek spesifik.`));
  }

  lines.push(uiBullet('⚠️', 'Probabilitas adalah estimasi model, bukan kepastian.'));
  return lines.join('\n\n');
}
