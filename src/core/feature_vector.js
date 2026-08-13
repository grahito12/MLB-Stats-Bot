/**
 * Stable feature-vector contract for the all-game research dataset.
 *
 * The feature vector is built ONLY from the frozen coreInputs that were
 * captured at prediction time — never recalculated from current files. This
 * is the bridge between the live JS control engine and offline Python
 * training/evaluation. It carries numeric values as observed (or null when
 * missing), sample sizes, and missingness indicators so a downstream model can
 * distinguish "absent" from "defaulted to league average".
 *
 * Contract rules:
 *  - Built from the SAME frozen inputs passed to buildCoreInputsSnapshot().
 *  - Numeric values as observed, or null. Never fabricated.
 *  - Feature hash covers schema, values, missingness, and source cutoffs —
 *    never outcomes.
 *  - Outcomes are separate labels and are never embedded here.
 *  - Versioned manifest: adding a feature bumps FEATURE_VECTOR_SCHEMA_VERSION.
 */

import { createHash } from 'node:crypto';
import { CONTROL_FEATURE_SCHEMA_VERSION } from './model_ids.js';

export const FEATURE_VECTOR_SCHEMA_VERSION = 'mlb-feature-vector-v1.0';

function num(value, fallback = null) {
  if (value == null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function gp(stat) {
  return Math.max(1, num(stat?.gamesPlayed ?? stat?.hitting?.gamesPlayed, 1));
}

function rpg(stat) {
  if (!stat) return null;
  const runs = num(stat.runs ?? stat.hitting?.runs, null);
  if (runs == null) return null;
  return runs / gp(stat);
}

function ops(stat) {
  return stat ? num(stat.ops ?? stat.hitting?.ops, null) : null;
}

function era(stat) {
  return stat ? num(stat.era ?? stat.pitching?.era, null) : null;
}

function whip(stat) {
  return stat ? num(stat.whip ?? stat.pitching?.whip, null) : null;
}

function recordPct(record) {
  if (!record) return null;
  if (record.pct != null) return num(record.pct, null);
  const w = num(record.wins, 0);
  const l = num(record.losses, 0);
  const t = w + l;
  return t > 0 ? w / t : null;
}

function splitPct(standing, type) {
  if (!standing?.records?.splitRecords) return null;
  const rec = standing.records.splitRecords.find((r) => r.type === type);
  return rec ? recordPct(rec) : null;
}

function runDiffPerGame(standing) {
  if (!standing) return null;
  const rd = num(standing.runDifferential, null);
  const games = num(standing.gamesPlayed ?? standing.leagueRecord?.wins + standing.leagueRecord?.losses, null);
  if (rd == null || !games || games <= 0) return null;
  return rd / games;
}

function gamesPlayedRecord(standing) {
  if (!standing) return null;
  return num(
    standing.gamesPlayed ?? (standing.leagueRecord ? standing.leagueRecord.wins + standing.leagueRecord.losses : null),
    null
  );
}

function withMissing(value) {
  return { value, missing: value == null ? 1 : 0 };
}

/**
 * Build the normalized feature vector from frozen coreInputs (plain JSON, the
 * same object buildCoreInputsSnapshot returns). Returns a plain JSON object.
 */
export function buildFeatureVector(coreInputs) {
  const raw = coreInputs || {};
  const game = raw.game || {};
  const teams = game.teams || {};
  const awayTeam = teams.away?.team || {};
  const homeTeam = teams.home?.team || {};
  const awayId = awayTeam.id;
  const homeId = homeTeam.id;

  const at = (obj, id) => (obj && id != null ? obj[id] : null);
  const awayStats = at(raw.teamStats, awayId);
  const homeStats = at(raw.teamStats, homeId);
  const awayStanding = at(raw.standings, awayId);
  const homeStanding = at(raw.standings, homeId);
  const awayRolling = at(raw.rollingTeamStats, awayId);
  const homeRolling = at(raw.rollingTeamStats, homeId);

  const awayPitcherId = teams.away?.probablePitcher?.id;
  const homePitcherId = teams.home?.probablePitcher?.id;
  const awayPitcher = at(raw.pitcherStats, awayPitcherId);
  const homePitcher = at(raw.pitcherStats, homePitcherId);
  const awayPitcherRecent = at(raw.pitcherRecentStarts, awayPitcherId);
  const homePitcherRecent = at(raw.pitcherRecentStarts, homePitcherId);

  const awayBullpen = at(raw.bullpenProfiles, awayId);
  const homeBullpen = at(raw.bullpenProfiles, homeId);
  const awaySched = at(raw.scheduleFatigueProfiles, awayId);
  const homeSched = at(raw.scheduleFatigueProfiles, homeId);
  const awayInjuries = at(raw.injuryProfiles, awayId);
  const homeInjuries = at(raw.injuryProfiles, homeId);

  const awayLineup = raw.lineupProfiles?.away || null;
  const homeLineup = raw.lineupProfiles?.home || null;
  const h2h = raw.headToHead || null;

  const weather = game.weather || {};
  const tempNum = num(weather.temp, null);
  const windMatch = typeof weather.wind === 'string' ? weather.wind.match(/([\d.]+)\s*mph/i) : null;
  const windSpeed = windMatch ? num(windMatch[1], null) : null;
  const windOut = typeof weather.wind === 'string' ? /out|cf|lf|rf/i.test(weather.wind) : null;
  const windIn = typeof weather.wind === 'string' ? /\bin\b/i.test(weather.wind) : null;

  // Pitcher handedness (opposing team's platoon context).
  const awayStarterHand = teams.away?.probablePitcher?.pitchHand?.code || null;
  const homeStarterHand = teams.home?.probablePitcher?.pitchHand?.code || null;

  const vector = {
    schemaVersion: FEATURE_VECTOR_SCHEMA_VERSION,
    featureSchemaVersion: CONTROL_FEATURE_SCHEMA_VERSION,
    gamePk: String(game.gamePk ?? ''),
    awayTeamId: awayId != null ? String(awayId) : null,
    homeTeamId: homeId != null ? String(homeId) : null,
    venueId: game.venue?.id != null ? num(game.venue.id, null) : null,
    officialDate: game.officialDate || null,

    // --- Team season offense (run-based + rate) ---
    awayRpg: withMissing(rpg(awayStats)),
    awayOps: withMissing(ops(awayStats)),
    homeRpg: withMissing(rpg(homeStats)),
    homeOps: withMissing(ops(homeStats)),
    awayTeamGames: withMissing(gamesPlayedRecord(awayStanding)),
    homeTeamGames: withMissing(gamesPlayedRecord(homeStanding)),

    // --- Team season pitching ---
    awayEra: withMissing(era(awayStats)),
    awayWhip: withMissing(whip(awayStats)),
    homeEra: withMissing(era(homeStats)),
    homeWhip: withMissing(whip(homeStats)),

    // --- Rolling recent form ---
    awayRollingRpg: withMissing(rpg(awayRolling)),
    awayRollingOps: withMissing(ops(awayRolling)),
    homeRollingRpg: withMissing(rpg(homeRolling)),
    homeRollingOps: withMissing(ops(homeRolling)),
    awayRollingGames: withMissing(awayRolling ? num(awayRolling.games, null) : null),
    homeRollingGames: withMissing(homeRolling ? num(homeRolling.games, null) : null),

    // --- Standings / record ---
    awayWinPct: withMissing(recordPct(awayStanding?.leagueRecord)),
    homeWinPct: withMissing(recordPct(homeStanding?.leagueRecord)),
    awayLastTenPct: withMissing(splitPct(awayStanding, 'lastTen')),
    homeLastTenPct: withMissing(splitPct(homeStanding, 'lastTen')),
    awayRunDiffPerGame: withMissing(runDiffPerGame(awayStanding)),
    homeRunDiffPerGame: withMissing(runDiffPerGame(homeStanding)),
    // Platoon splits vs opposing starter hand:
    awayVsStarterHandPct: withMissing(
      homeStarterHand === 'L' ? splitPct(awayStanding, 'left') : splitPct(awayStanding, 'right')
    ),
    homeVsStarterHandPct: withMissing(
      awayStarterHand === 'L' ? splitPct(homeStanding, 'left') : splitPct(homeStanding, 'right')
    ),

    // --- Probable starter season ---
    awayStarterEra: withMissing(era(awayPitcher)),
    awayStarterWhip: withMissing(whip(awayPitcher)),
    homeStarterEra: withMissing(era(homePitcher)),
    homeStarterWhip: withMissing(whip(homePitcher)),
    awayStarterKMinusBb: withMissing(
      awayPitcher ? num(awayPitcher.strikeoutsMinusWalksPercentage, null) : null
    ),
    homeStarterKMinusBb: withMissing(
      homePitcher ? num(homePitcher.strikeoutsMinusWalksPercentage, null) : null
    ),
    awayStarterHr9: withMissing(awayPitcher ? num(awayPitcher.homeRunsPer9, null) : null),
    homeStarterHr9: withMissing(homePitcher ? num(homePitcher.homeRunsPer9, null) : null),

    // --- Probable starter recent ---
    awayStarterRecentEra: withMissing(era(awayPitcherRecent)),
    awayStarterRecentWhip: withMissing(whip(awayPitcherRecent)),
    awayStarterRecentInnings: withMissing(awayPitcherRecent ? num(awayPitcherRecent.innings, null) : null),
    homeStarterRecentEra: withMissing(era(homePitcherRecent)),
    homeStarterRecentWhip: withMissing(whip(homePitcherRecent)),
    homeStarterRecentInnings: withMissing(homePitcherRecent ? num(homePitcherRecent.innings, null) : null),

    // --- Bullpen fatigue ---
    awayBullpenFatigue: withMissing(awayBullpen ? num(awayBullpen.fatigueScore, null) : null),
    homeBullpenFatigue: withMissing(homeBullpen ? num(homeBullpen.fatigueScore, null) : null),
    awayBullpenBackToBack: withMissing(awayBullpen ? num(awayBullpen.backToBackRelievers, null) : null),
    homeBullpenBackToBack: withMissing(homeBullpen ? num(homeBullpen.backToBackRelievers, null) : null),

    // --- Schedule fatigue ---
    awayRestDays: withMissing(awaySched ? num(awaySched.restDays, null) : null),
    homeRestDays: withMissing(homeSched ? num(homeSched.restDays, null) : null),
    awayRoadStreak: withMissing(awaySched ? num(awaySched.roadStreak, null) : null),
    homeRoadStreak: withMissing(homeSched ? num(homeSched.roadStreak, null) : null),

    // --- Lineup ---
    awayLineupConfirmed: withMissing(awayLineup?.confirmed == null ? null : awayLineup.confirmed ? 1 : 0),
    homeLineupConfirmed: withMissing(homeLineup?.confirmed == null ? null : homeLineup.confirmed ? 1 : 0),
    awayLineupQuality: withMissing(awayLineup ? num(awayLineup.qualityScore, null) : null),
    homeLineupQuality: withMissing(homeLineup ? num(homeLineup.qualityScore, null) : null),
    awayLineupCount: withMissing(awayLineup ? num(awayLineup.count, null) : null),
    homeLineupCount: withMissing(homeLineup ? num(homeLineup.count, null) : null),

    // --- Injuries (hitter count) ---
    awayInjuryCount: withMissing(Array.isArray(awayInjuries) ? awayInjuries.length : null),
    homeInjuryCount: withMissing(Array.isArray(homeInjuries) ? homeInjuries.length : null),

    // --- Head to head ---
    h2hGames: withMissing(h2h?.games ? num(h2h.games, null) : null),
    h2hHomeWinPct: withMissing(
      h2h?.games > 0 && h2h.homeProbability != null ? num(h2h.homeProbability, null) / 100 : null
    ),

    // --- Weather ---
    temperature: withMissing(tempNum),
    windSpeed: withMissing(windSpeed),
    windHittingOut: withMissing(windOut == null ? null : windOut ? 1 : 0),
    windHittingIn: withMissing(windIn == null ? null : windIn ? 1 : 0),

    // --- Pitcher handedness (categorical, encoded) ---
    awayStarterHandLeft: withMissing(
      awayStarterHand == null ? null : awayStarterHand === 'L' ? 1 : 0
    ),
    homeStarterHandLeft: withMissing(
      homeStarterHand == null ? null : homeStarterHand === 'L' ? 1 : 0
    )
  };

  vector.featureVectorHash = hashFeatureVector(vector);
  return vector;
}

function stableStringify(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Hash a feature vector. Covers schema, values, and missingness — never
 * outcomes. Used for dedup and dataset integrity.
 */
export function hashFeatureVector(vector) {
  const { featureVectorHash: _omit, ...body } = vector;
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

/**
 * Flatten the nested {value, missing} pairs into a simple numeric object for
 * Python/CSV consumption. Missing values become null; missingness flags become
 * `missing_<feature>` columns.
 */
export function flattenFeatureVector(vector) {
  const flat = {
    schemaVersion: vector.schemaVersion,
    featureSchemaVersion: vector.featureSchemaVersion,
    gamePk: vector.gamePk,
    awayTeamId: vector.awayTeamId,
    homeTeamId: vector.homeTeamId,
    venueId: vector.venueId,
    officialDate: vector.officialDate,
    featureVectorHash: vector.featureVectorHash
  };
  for (const [key, cell] of Object.entries(vector)) {
    if (['schemaVersion', 'featureSchemaVersion', 'gamePk', 'awayTeamId', 'homeTeamId', 'venueId', 'officialDate', 'featureVectorHash'].includes(key)) {
      continue;
    }
    if (cell && typeof cell === 'object' && 'value' in cell) {
      flat[key] = cell.value;
      flat[`missing_${key}`] = cell.missing;
    } else {
      flat[key] = cell;
    }
  }
  return flat;
}

/**
 * Classify an information state from actual timestamps + lineup confirmation.
 * Classification is metadata; it never changes control scoring.
 *
 *   scheduled_early   — far from first pitch, lineups not confirmed
 *   projected_lineup  — lineups present but not confirmed
 *   confirmed_lineup  — both lineups confirmed
 *   close_time        — within CLOSE_TIME_HOURS of first pitch
 *   ineligible        — as_of >= first_pitch (post-pitch)
 */
export const CLOSE_TIME_HOURS = 2;

export function classifyInformationState({ asOfUtc, firstPitchUtc, lineupsConfirmed }) {
  if (!asOfUtc || !firstPitchUtc) return 'ineligible';
  const asOf = Date.parse(asOfUtc);
  const firstPitch = Date.parse(firstPitchUtc);
  if (!Number.isFinite(asOf) || !Number.isFinite(firstPitch)) return 'ineligible';
  if (asOf >= firstPitch) return 'ineligible';
  const hoursBefore = (firstPitch - asOf) / 3.6e6;
  if (hoursBefore <= CLOSE_TIME_HOURS) return 'close_time';
  if (lineupsConfirmed === true) return 'confirmed_lineup';
  if (lineupsConfirmed === false) return 'projected_lineup';
  return 'scheduled_early';
}
