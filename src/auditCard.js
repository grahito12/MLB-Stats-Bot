/**
 * Telegram Prediction Audit Card (/auditcard).
 *
 * JS port of the read paths in src/prediction_audit.py, over the SAME live
 * sqlite handle the bot already holds (storage.db). Read-only: answers
 * "what did the system know at that moment, which model produced the
 * probability, why BET/NO BET, and what happened afterwards" for one
 * immutable model_predictions row.
 *
 * Rules mirrored from the Python module:
 *  - Never fabricate: unrecorded fields render as "tidak terekam".
 *  - Market at prediction time only uses quote pairs with
 *    fetched_at_utc <= as_of_utc; a paired quote violating that falls back
 *    to the nearest pre-as_of eligible quote (labeled fallback).
 *  - Closing quotes are evaluation-only and shown separately.
 *  - Contributions come from the persisted modelBreakdown of the actual
 *    production formula; components sum to rawEdge (verified, not assumed).
 */

import { UI_LINE, UI_THIN_LINE, uiSection } from './telegramFormat.js';

const NOT_RECORDED = 'tidak terekam';

// Mirror of _HEURISTIC_COMPONENTS in src/prediction_audit.py — keep in sync
// with predictGameMoneylineCore's modelBreakdown.
const HEURISTIC_COMPONENTS = [
  ['starting pitcher', 'starterEdge', false],
  ['offense', 'offenseEdge', false],
  ['run prevention', 'preventionEdge', false],
  ['lineup', 'lineupEdge', false],
  ['bullpen', 'bullpenEdge', false],
  ['schedule fatigue', 'fatigueEdge', false],
  ['season record (log5)', 'log5Edge', true],
  ['recent form', 'formEdge', true],
  ['head to head', 'h2hEdge', true],
  ['model memory', 'memoryEdge', true],
  ['platoon split', 'platoonEdge', true],
  ['home field', 'homeFieldEdge', false],
  ['weather', 'weatherEdge', false],
  ['lineup confirmation', 'confirmationEdge', false]
];

const RECORD_DOMINATED_MULTIPLIER = 0.45;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function tableExists(db, name) {
  try {
    return Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
    );
  } catch {
    return false;
  }
}

function pct(value, digits = 1) {
  const parsed = num(value);
  return parsed == null ? NOT_RECORDED : `${parsed.toFixed(digits)}%`;
}

function fracPct(value, digits = 1) {
  const parsed = num(value);
  return parsed == null ? NOT_RECORDED : `${(parsed * 100).toFixed(digits)}%`;
}

function signed(value, digits = 2, suffix = '') {
  const parsed = num(value);
  if (parsed == null) return NOT_RECORDED;
  return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(digits)}${suffix}`;
}

function americanOdds(value) {
  const parsed = num(value);
  if (parsed == null) return NOT_RECORDED;
  return parsed > 0 ? `+${parsed}` : `${parsed}`;
}

// ---------------------------------------------------------------------------
// Selection: find the model_predictions row the user asked for.
// ---------------------------------------------------------------------------

export function listAuditRows(db, dateYmd, limit = 15) {
  if (!tableExists(db, 'model_predictions')) return null;
  const hasPicks = tableExists(db, 'picks');
  const hasOutcomes = tableExists(db, 'game_outcomes');
  // One row per (game, model): the latest immutable prediction. picks is
  // append-only (multiple versions per run), so join only its latest row.
  return db
    .prepare(
      `SELECT mp.prediction_id, mp.run_id, mp.game_pk, mp.date_ymd, mp.model_id,
              mp.status, mp.pick_side, mp.pick_probability, mp.created_at
              ${hasPicks ? `, (SELECT p.matchup FROM picks p WHERE p.run_id = mp.run_id ORDER BY p.saved_at DESC LIMIT 1) AS matchup` : ', NULL AS matchup'}
              ${hasOutcomes ? ', (o.game_pk IS NOT NULL) AS has_result' : ', 0 AS has_result'}
       FROM model_predictions mp
       ${hasOutcomes ? 'LEFT JOIN game_outcomes o ON o.game_pk = mp.game_pk' : ''}
       WHERE (? IS NULL OR mp.date_ymd = ?)
         AND mp.created_at = (
           SELECT MAX(inner_mp.created_at) FROM model_predictions inner_mp
           WHERE inner_mp.game_pk = mp.game_pk AND inner_mp.model_id = mp.model_id
         )
       ORDER BY mp.date_ymd DESC, mp.created_at DESC
       LIMIT ?`
    )
    .all(dateYmd ?? null, dateYmd ?? null, Math.max(1, Math.min(limit, 50)));
}

/**
 * Resolve a user query (team name/abbr, game_pk, or prediction_id) to one
 * model_predictions row, preferring the requested date, else the most recent.
 */
export function findAuditRow(db, query, dateYmd) {
  if (!tableExists(db, 'model_predictions')) return null;
  const text = String(query || '').trim();

  if (/^mp-/.test(text)) {
    return db.prepare('SELECT * FROM model_predictions WHERE prediction_id = ?').get(text) || null;
  }
  if (/^\d{6,}$/.test(text)) {
    return (
      db
        .prepare('SELECT * FROM model_predictions WHERE game_pk = ? ORDER BY created_at DESC LIMIT 1')
        .get(text) || null
    );
  }

  const hasPicks = tableExists(db, 'picks');
  if (!text) {
    return (
      db
        .prepare(
          `SELECT * FROM model_predictions
           WHERE (? IS NULL OR date_ymd = ?)
           ORDER BY date_ymd DESC, created_at DESC LIMIT 1`
        )
        .get(dateYmd ?? null, dateYmd ?? null) || null
    );
  }
  if (!hasPicks) return null;

  // Team-name match through the picks join (matchup contains full names).
  return (
    db
      .prepare(
        `SELECT mp.* FROM model_predictions mp
         JOIN picks p ON p.run_id = mp.run_id
         WHERE LOWER(p.matchup) LIKE ?
           AND (? IS NULL OR mp.date_ymd = ?)
         ORDER BY mp.date_ymd DESC, mp.created_at DESC LIMIT 1`
      )
      .get(`%${text.toLowerCase()}%`, dateYmd ?? null, dateYmd ?? null) || null
  );
}

// ---------------------------------------------------------------------------
// Assembly (mirrors get_prediction_audit joins)
// ---------------------------------------------------------------------------

function marketContext(db, gamePk, pairedQuotePairId, asOf) {
  if (!tableExists(db, 'market_quote_pairs')) return { atPrediction: null, closing: null, source: null };

  let atPrediction = null;
  let source = null;
  if (pairedQuotePairId) {
    const row = db
      .prepare('SELECT * FROM market_quote_pairs WHERE quote_pair_id = ?')
      .get(pairedQuotePairId);
    if (row && (!asOf || !row.fetched_at_utc || row.fetched_at_utc <= asOf)) {
      atPrediction = row;
      source = 'paired';
    }
  }
  if (!atPrediction && asOf) {
    atPrediction =
      db
        .prepare(
          `SELECT * FROM market_quote_pairs
           WHERE game_pk = ? AND market = 'moneyline' AND is_eligible = 1
             AND fetched_at_utc IS NOT NULL AND fetched_at_utc <= ?
           ORDER BY fetched_at_utc DESC LIMIT 1`
        )
        .get(String(gamePk), asOf) || null;
    if (atPrediction) source = 'nearest_pre_as_of';
  }

  const closing =
    db
      .prepare(
        `SELECT * FROM market_quote_pairs
         WHERE game_pk = ? AND market = 'moneyline' AND is_closing = 1 AND is_eligible = 1
         ORDER BY fetched_at_utc DESC LIMIT 1`
      )
      .get(String(gamePk)) || null;

  return { atPrediction, closing, source };
}

export function buildContributions(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return null;
  const recordMultiplier = breakdown.recordDominated ? RECORD_DOMINATED_MULTIPLIER : 1;
  const rawEdge = num(breakdown.rawEdge);
  const rows = [];
  let total = 0;
  for (const [label, key, isRecordContext] of HEURISTIC_COMPONENTS) {
    const value = num(breakdown[key]);
    if (value == null) continue;
    const contribution = value * (isRecordContext ? recordMultiplier : 1);
    total += contribution;
    rows.push({ label, contribution });
  }
  if (!rows.length) return null;
  rows.sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution));
  return {
    rows,
    total,
    rawEdge,
    complete: rawEdge != null && Math.abs(total - rawEdge) < 1e-6,
    recordDominated: Boolean(breakdown.recordDominated)
  };
}

export function assembleAuditCard(db, mp) {
  const run = tableExists(db, 'prediction_runs')
    ? db.prepare('SELECT * FROM prediction_runs WHERE run_id = ?').get(mp.run_id)
    : null;
  const pick = tableExists(db, 'picks')
    ? db.prepare('SELECT * FROM picks WHERE run_id = ? ORDER BY saved_at DESC LIMIT 1').get(mp.run_id)
    : null;

  const mpPayload = parseJson(mp.payload) || {};
  const runPayload = run ? parseJson(run.payload) : null;
  const pickPayload = pick ? parseJson(pick.payload) : null;

  const breakdown =
    (mpPayload.modelBreakdown && typeof mpPayload.modelBreakdown === 'object'
      ? mpPayload.modelBreakdown
      : null) || pickPayload?.modelBreakdown || null;

  const betDecision = pickPayload?.betDecision || runPayload?.betDecision || null;
  const quality = pickPayload?.predictionQuality || null;
  const fallbacks = mpPayload.featureFallbacks || pickPayload?.featureFallbacks || null;

  const home = pickPayload?.home || null;
  const away = pickPayload?.away || null;

  const market = marketContext(db, mp.game_pk, mp.paired_quote_pair_id, mp.as_of_utc);

  const outcome = tableExists(db, 'game_outcomes')
    ? db.prepare('SELECT * FROM game_outcomes WHERE game_pk = ?').get(String(mp.game_pk))
    : null;
  const ledger = tableExists(db, 'bet_ledger')
    ? db
        .prepare(
          `SELECT * FROM bet_ledger
           WHERE (run_id = ? OR game_pk = ?) AND market = 'moneyline'
           ORDER BY recommended_at DESC LIMIT 1`
        )
        .get(mp.run_id, String(mp.game_pk))
    : null;

  return {
    mp,
    matchup: pick?.matchup || null,
    home,
    away,
    breakdown,
    betDecision,
    quality,
    fallbacks,
    market,
    outcome,
    ledger,
    snapshotPath: runPayload?.snapshotPath || null
  };
}

// ---------------------------------------------------------------------------
// Telegram rendering
// ---------------------------------------------------------------------------

export function formatAuditList(rows, dateYmd) {
  const lines = ['🔍 PREDICTION AUDIT', UI_LINE];
  if (!rows || !rows.length) {
    lines.push(
      dateYmd
        ? `Tidak ada prediksi immutable untuk ${dateYmd}.`
        : 'Belum ada prediksi immutable yang terekam.'
    );
    return lines.join('\n');
  }
  lines.push(dateYmd ? `Prediksi ${dateYmd}:` : 'Prediksi terbaru:', '');
  for (const row of rows) {
    const status = row.status || '-';
    const result = row.has_result ? '✅ settled' : '⏳ pending';
    lines.push(
      `• ${row.matchup || row.game_pk} — ${row.date_ymd || '?'}`,
      `   ${row.model_id} | ${status} | pick ${row.pick_side || '-'} ${pct(row.pick_probability)} | ${result}`
    );
  }
  lines.push(
    '',
    UI_THIN_LINE,
    'Detail: /auditcard TEAM',
    'Contoh: /auditcard yankees | /auditcard 2026-08-20 dodgers'
  );
  return lines.join('\n');
}

export function formatAuditCard(card) {
  const { mp, matchup, home, away, breakdown, betDecision, quality, fallbacks, market, outcome, ledger, snapshotPath } = card;
  const homeAbbr = home?.abbreviation || 'HOME';
  const awayAbbr = away?.abbreviation || 'AWAY';

  const lines = [];
  lines.push('🔍 PREDICTION AUDIT CARD', UI_LINE);
  lines.push(matchup || `game ${mp.game_pk}`);
  lines.push(`${mp.date_ymd || '?'} | first pitch ${mp.first_pitch_utc || NOT_RECORDED}`);

  // Model identity
  lines.push('', uiSection('🧠', 'MODEL'));
  lines.push(`• ${mp.model_id} ${mp.model_impl_version || mp.model_version || ''}`.trimEnd());
  lines.push(`• kalibrasi: ${mp.calibration_version || NOT_RECORDED}${mp.calibration_status ? ` (${mp.calibration_status})` : ''}`);
  lines.push(`• as-of: ${mp.as_of_utc || NOT_RECORDED}`);

  // Probability stages — raw vs calibrated vs market kept visually distinct.
  lines.push('', uiSection('📊', 'PROBABILITAS'));
  lines.push(`• raw model: ${awayAbbr} ${pct(mp.raw_away_probability)} / ${homeAbbr} ${pct(mp.raw_home_probability)}`);
  lines.push(`• calibrated: ${awayAbbr} ${pct(mp.calibrated_away_probability)} / ${homeAbbr} ${pct(mp.calibrated_home_probability)}`);
  const quote = market.atPrediction;
  if (quote) {
    lines.push(`• market no-vig: ${awayAbbr} ${fracPct(quote.away_no_vig_prob)} / ${homeAbbr} ${fracPct(quote.home_no_vig_prob)}`);
    const modelHome = num(mp.calibrated_home_probability);
    const marketHome = num(quote.home_no_vig_prob);
    if (modelHome != null && marketHome != null) {
      lines.push(`• model − market (${homeAbbr}): ${signed(modelHome - marketHome * 100, 1, ' pts')}`);
    }
    lines.push(
      `• quote: ${quote.bookmaker || '?'} ${awayAbbr} ${americanOdds(quote.away_odds)} / ${homeAbbr} ${americanOdds(quote.home_odds)}` +
        `${market.source === 'nearest_pre_as_of' ? ' (pre-as_of terdekat)' : ''}`
    );
  } else {
    lines.push('• market saat prediksi: tidak ada quote <= as-of');
  }

  // Decision
  const status = betDecision?.status || mp.status || NOT_RECORDED;
  const isBet = /^(VALUE|BET)$/i.test(String(status));
  lines.push('', uiSection(isBet ? '✅' : '🚫', `KEPUTUSAN: ${status}`));
  const pickName =
    betDecision?.teamName ||
    (mp.pick_side === 'home' ? home?.name : mp.pick_side === 'away' ? away?.name : null);
  lines.push(`• pick model: ${pickName || mp.pick_side || NOT_RECORDED} ${pct(mp.pick_probability)}`);
  if (betDecision) {
    if (num(betDecision.edge) != null) lines.push(`• edge: ${signed(betDecision.edge, 1, '%')}`);
    if (betDecision.odds != null) lines.push(`• odds: ${americanOdds(betDecision.odds)} (${betDecision.book || '?'})`);
    if (num(betDecision.kellyStakePercent) != null) lines.push(`• kelly stake: ${betDecision.kellyStakePercent}%`);
  }
  const reasons = Array.isArray(betDecision?.reasons)
    ? betDecision.reasons
    : betDecision?.reason
      ? [betDecision.reason]
      : parseJson(mp.reason_codes) || [];
  if (reasons.length) {
    lines.push('• alasan:');
    for (const reason of reasons.slice(0, 4)) lines.push(`   - ${reason}`);
  } else {
    lines.push(`• alasan: ${NOT_RECORDED}`);
  }

  // Feature contributions (exact decomposition)
  const contributions = buildContributions(breakdown);
  lines.push('', uiSection('🧩', 'KONTRIBUSI FITUR'));
  if (contributions) {
    for (const row of contributions.rows.slice(0, 6)) {
      const icon = row.contribution >= 0 ? '🟢' : '🔴';
      lines.push(`${icon} ${row.label}: ${signed(row.contribution, 3)}`);
    }
    lines.push(
      contributions.complete
        ? `Σ komponen = raw edge ${signed(contributions.rawEdge, 3)} (dekomposisi exact${contributions.recordDominated ? ', record-context ×0.45' : ''})`
        : '⚠ dekomposisi tidak lengkap terhadap raw edge'
    );
  } else {
    lines.push(NOT_RECORDED);
  }

  // Data quality
  lines.push('', uiSection('🩺', 'DATA QUALITY'));
  lines.push(`• status: ${quality?.status || NOT_RECORDED} | lineup: ${mp.information_state || NOT_RECORDED}`);
  const qualityReasons = Array.isArray(quality?.reasons) ? quality.reasons : [];
  for (const reason of qualityReasons.slice(0, 3)) lines.push(`   ⚠ ${reason}`);
  const fallbackFeatures = Array.isArray(fallbacks?.features) ? fallbacks.features : [];
  if (fallbackFeatures.length) lines.push(`• fallback: ${fallbackFeatures.join(', ')}`);

  // Result + CLV (evaluation-only, separate from prediction-time data)
  lines.push('', uiSection('🏁', 'HASIL'));
  if (outcome) {
    lines.push(`• skor: ${awayAbbr} ${outcome.away_score} — ${homeAbbr} ${outcome.home_score}`);
    let winnerSide = null;
    if (outcome.winner_team_id != null) {
      if (String(outcome.winner_team_id) === String(home?.id)) winnerSide = 'home';
      else if (String(outcome.winner_team_id) === String(away?.id)) winnerSide = 'away';
    }
    if (winnerSide == null && outcome.home_score != null && outcome.away_score != null) {
      winnerSide = outcome.home_score > outcome.away_score ? 'home' : 'away';
    }
    if (winnerSide && mp.pick_side) {
      lines.push(`• pick model: ${winnerSide === mp.pick_side ? '✅ BENAR' : '❌ SALAH'}`);
    }
  } else {
    lines.push('• game belum settled');
  }
  const closing = market.closing;
  if (closing) {
    lines.push(`• closing no-vig: ${awayAbbr} ${fracPct(closing.away_no_vig_prob)} / ${homeAbbr} ${fracPct(closing.home_no_vig_prob)} (${closing.bookmaker || '?'})`);
  } else {
    lines.push(`• closing line: ${NOT_RECORDED}`);
  }
  if (ledger) {
    lines.push(`• bet: ${ledger.result || ledger.status || '?'} | P/L ${signed(ledger.units_pl, 2, 'u')} | CLV ${signed(ledger.clv, 2)}`);
  } else if (isBet) {
    lines.push(`• bet ledger: ${NOT_RECORDED}`);
  }

  // Reproducibility identity
  lines.push('', UI_THIN_LINE);
  lines.push(`id: ${mp.prediction_id}`);
  lines.push(`snapshot: ${mp.snapshot_hash ? mp.snapshot_hash.slice(0, 16) + '…' : NOT_RECORDED}${snapshotPath ? ' (tersimpan)' : ''}`);
  lines.push(`promotion eligible: ${mp.promotion_eligible ? 'ya' : 'tidak'}`);

  return lines.join('\n');
}

/**
 * Entry point for the /auditcard command.
 * args: optional "YYYY-MM-DD", team text, game_pk, or prediction id — in any order.
 */
export function handleAuditCardQuery(db, argsText) {
  const text = String(argsText || '').trim();
  const dateMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const dateYmd = dateMatch ? dateMatch[1] : null;
  const query = text.replace(dateMatch ? dateMatch[1] : '', '').trim();

  if (!tableExists(db, 'model_predictions')) {
    return '🔍 PREDICTION AUDIT\n' + UI_LINE + '\nTabel model_predictions belum ada (migrasi 006 belum diterapkan).';
  }

  // No team/id query → list mode (optionally date-filtered).
  if (!query) {
    if (dateYmd) {
      const rows = listAuditRows(db, dateYmd);
      return formatAuditList(rows, dateYmd);
    }
    const rows = listAuditRows(db, null);
    return formatAuditList(rows, null);
  }

  const mp = findAuditRow(db, query, dateYmd);
  if (!mp) {
    return (
      '🔍 PREDICTION AUDIT\n' +
      UI_LINE +
      `\nTidak ketemu prediksi untuk "${query}"${dateYmd ? ` pada ${dateYmd}` : ''}.` +
      '\nCoba /auditcard untuk daftar prediksi terbaru.'
    );
  }
  return formatAuditCard(assembleAuditCard(db, mp));
}
