// P4 candidate-feature collectors (timestamp-safe, shadow research only).
//
// Each collector builds a compact JSON payload from pre-game data and writes it
// ONCE into the generic feature_snapshots store (keyed by game_pk + feature_group).
// These payloads are read later by the offline Python extractor
// (src/candidate_features.py) to build a versioned mlb-candidate-features-v1.0
// vector for shadow training. They are NOT wired into heuristic_v1 and never
// run inside /predict as a Python child process.
//
// Timestamp-safe contracts:
//   - Every payload carries as_of_utc + fetched_at_utc provenance at top level.
//   - The orchestrator refuses to write when as_of_utc >= first_pitch_utc
//     (post-pitch evidence is temporally ineligible — never recorded as pregame).
//   - BvP events are filtered to game_date < predictionDate (strict before-date)
//     because the upstream aggregator has no date cutoff of its own.
//   - Missing local data yields a null field + sample size, never a fabricated
//     value. League-average shrinkage happens at training time inside the fold.
//   - Relievers who appeared in the target game are never used for bullpen
//     quality (only prior-date reliever data is eligible).

export const CANDIDATE_FEATURE_SCHEMA_VERSION = 'mlb-candidate-features-v1.0';
export const CANDIDATE_FEATURE_MANIFEST_VERSION = 'candidate-features-v1';

// Feature groups written to feature_snapshots. Must match the Python extractor.
export const CANDIDATE_GROUPS = [
  'statcast_team',
  'pitch_arsenal',
  'expected_innings',
  'bullpen_quality',
  'lineup_batter',
  'bvp',
  'starter_xera'
];

function num(value, fallback = null) {
  if (value == null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round3(value) {
  const n = num(value, null);
  return n == null ? null : Math.round(n * 1000) / 1000;
}

// ---------- Pure payload builders ----------

/**
 * Build the statcast_team payload: rolling team xStats per side.
 * @param {object} inputs - { away: {xwoba,xslg,barrelRate,hardHitRate,samplePa}, home: {...} }
 * Each side is null/absent when no Statcast data was observed pregame.
 */
export function buildStatcastTeamPayload(inputs = {}) {
  const pick = (side) => {
    const s = inputs[side];
    if (!s) return null;
    return {
      xwoba: round3(s.xwoba),
      xslg: round3(s.xslg),
      barrel_rate: round3(s.barrelRate),
      hard_hit_rate: round3(s.hardHitRate),
      sample_pa: num(s.samplePa, 0)
    };
  };
  return {
    away: pick('away'),
    home: pick('home')
  };
}

/**
 * Build the pitch_arsenal payload: starter Stuff+ + platoon split per side.
 */
export function buildPitchArsenalPayload(inputs = {}) {
  const pick = (side) => {
    const s = inputs[side];
    if (!s) return null;
    return {
      overall_stuff_plus: round3(s.overallStuffPlus),
      stuff_vs_lhh: round3(s.stuffVsLhh),
      stuff_vs_rhh: round3(s.stuffVsRhh),
      sample_pitches: num(s.samplePitches, 0)
    };
  };
  return {
    away: pick('away'),
    home: pick('home')
  };
}

/**
 * Build the expected_innings payload: projected starter innings from prior starts.
 */
export function buildExpectedInningsPayload(inputs = {}) {
  const pick = (side) => {
    const s = inputs[side];
    if (!s) return null;
    return {
      expected_innings: round3(s.expectedInnings),
      prior_starts: num(s.priorStarts, 0)
    };
  };
  return {
    away: pick('away'),
    home: pick('home')
  };
}

/**
 * Build the bullpen_quality payload: prior-date reliever quality weighted by
 * expected bullpen innings (9 - expected starter innings).
 * @param {object} inputs - { away: {qualityScore, availableInnings, sampleRelievers, expectedStarterInnings}, home: {...} }
 */
export function buildBullpenQualityPayload(inputs = {}) {
  const pick = (side) => {
    const s = inputs[side];
    if (!s) return null;
    const expectedStarterInnings = num(s.expectedStarterInnings, null);
    // Available innings = 9 - expected starter innings (clamped to [0,9]).
    const avail = expectedStarterInnings == null
      ? null
      : Math.max(0, Math.min(9, 9 - expectedStarterInnings));
    return {
      quality_score: round3(s.qualityScore),
      available_innings: round3(avail),
      sample_relievers: num(s.sampleRelievers, 0)
    };
  };
  return {
    away: pick('away'),
    home: pick('home')
  };
}

/**
 * Build the lineup_batter payload: AB-weighted lineup OPS + confirmation state.
 */
export function buildLineupBatterPayload(inputs = {}) {
  const pick = (side) => {
    const s = inputs[side];
    if (!s) return null;
    return {
      weighted_ops: round3(s.weightedOps),
      batters_captured: num(s.battersCaptured, 0),
      confirmed: s.confirmed == null ? null : s.confirmed ? 1 : 0
    };
  };
  return {
    away: pick('away'),
    home: pick('home')
  };
}

/**
 * Build the bvp payload: lineup-vs-opposing-starter BvP (PA-shrunk at collection).
 * Events must already be filtered to game_date < predictionDate by the caller;
 * this builder does not re-filter. Returns null for a side below MIN_PLATE_APPEARANCES.
 */
export const MIN_BVP_PA = 50;

export function buildBvpPayload(inputs = {}) {
  const pick = (side) => {
    const s = inputs[side];
    if (!s) return null;
    const pa = num(s.plateAppearances, 0);
    if (pa < MIN_BVP_PA) return null; // insufficient — stays null, not a guess
    return {
      ops: round3(s.ops),
      plate_appearances: pa
    };
  };
  return {
    away: pick('away'),
    home: pick('home')
  };
}

/**
 * Build the starter_xera payload: pitcher expected ERA proxy from Statcast contact quality.
 */
export function buildStarterXeraPayload(inputs = {}) {
  const pick = (side) => {
    const s = inputs[side];
    if (!s) return null;
    return {
      xera: round3(s.xera),
      sample_bf: num(s.sampleBf, 0)
    };
  };
  return {
    away: pick('away'),
    home: pick('home')
  };
}

// ---------- Orchestrator ----------

/**
 * Write candidate payloads for one game into feature_snapshots (write-once).
 * Each non-empty family is written only if promotion-safe (as_of < first_pitch).
 * Returns the list of {group, written, reason} for audit. Never throws on a
 * missing family — it is simply skipped (absent = null at extract time).
 *
 * @param {object} storage - Storage instance (setFeatureSnapshot)
 * @param {object} ctx - { gamePk, dateYmd, asOfUtc, firstPitchUtc }
 * @param {object} payloads - { statcast_team, pitch_arsenal, expected_innings,
 *   bullpen_quality, lineup_batter, bvp, starter_xera } each a payload object
 *   (built by the builders above) or null
 */
export function writeCandidateSnapshots(storage, ctx, payloads) {
  const { gamePk, dateYmd, asOfUtc, firstPitchUtc } = ctx || {};
  const results = [];
  if (!storage || !gamePk) {
    return [{ group: null, written: false, reason: 'missing_game_pk_or_storage' }];
  }

  // Promotion-safety gate: refuse to record any candidate whose evidence is not
  // strictly pre-pitch. Post-pitch captures are temporally ineligible.
  const safe = isPromotionSafe(asOfUtc, firstPitchUtc);
  if (!safe.ok) {
    return CANDIDATE_GROUPS.map((group) => ({
      group,
      written: false,
      reason: `temporal_ineligible:${safe.reason}`
    }));
  }

  for (const group of CANDIDATE_GROUPS) {
    const payload = payloads?.[group];
    if (!payload || typeof payload !== 'object') {
      results.push({ group, written: false, reason: 'no_payload' });
      continue;
    }
    // Attach provenance so the extractor can re-verify promotion-safety.
    const stamped = {
      ...payload,
      as_of_utc: asOfUtc || null,
      fetched_at_utc: asOfUtc || null,
      schema_version: CANDIDATE_FEATURE_SCHEMA_VERSION
    };
    // Skip writing an all-null payload (both sides absent) — it carries no info.
    if (isEmptyPayload(stamped)) {
      results.push({ group, written: false, reason: 'empty_payload' });
      continue;
    }
    const written = storage.setFeatureSnapshot(gamePk, group, dateYmd, stamped);
    results.push({ group, written, reason: written ? null : 'already_captured' });
  }
  return results;
}

/**
 * Promotion-safety check: evidence must be observed strictly before first pitch.
 * as_of_utc < first_pitch_utc (both parseable). Post-pitch is ineligible.
 */
export function isPromotionSafe(asOfUtc, firstPitchUtc) {
  if (!asOfUtc || !firstPitchUtc) {
    return { ok: false, reason: 'missing_timestamps' };
  }
  const asOf = Date.parse(asOfUtc);
  const firstPitch = Date.parse(firstPitchUtc);
  if (!Number.isFinite(asOf) || !Number.isFinite(firstPitch)) {
    return { ok: false, reason: 'unparseable_timestamps' };
  }
  if (asOf >= firstPitch) {
    return { ok: false, reason: 'post_pitch_as_of' };
  }
  return { ok: true, reason: null };
}

function isEmptyPayload(payload) {
  // A payload is empty if every side value is null/absent.
  for (const key of ['away', 'home']) {
    if (payload[key] != null) return false;
  }
  return true;
}
