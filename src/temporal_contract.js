/**
 * UTC point-in-time temporal contract helpers.
 *
 * Statuses: fresh | stale | missing | invalid_future | invalid
 * Pregame eligibility: observed/effective <= as_of < first_pitch
 */

const DEFAULT_CLOCK_SKEW_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Parse a timestamp to epoch ms (UTC). Returns null if unparseable.
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseUtcMs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: seconds vs ms
    return value < 1e12 ? value * 1000 : value;
  }
  const text = String(value).trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {unknown} value
 * @returns {string|null} ISO UTC string
 */
export function toUtcIso(value) {
  const ms = parseUtcMs(value);
  if (ms == null) return null;
  return new Date(ms).toISOString();
}

/**
 * Classify data freshness with explicit invalid_future.
 * Future timestamps (beyond clock skew) are never "fresh".
 *
 * @param {unknown} dataTimestamp
 * @param {number} maxAgeMinutes
 * @param {{ now?: number|Date|string, clockSkewMs?: number }} [options]
 * @returns {'fresh'|'stale'|'missing'|'invalid_future'|'invalid'}
 */
export function checkDataFreshness(dataTimestamp, maxAgeMinutes, options = {}) {
  const parsed = parseUtcMs(dataTimestamp);
  if (parsed == null) return 'missing';

  const nowMs = parseUtcMs(options.now ?? Date.now());
  if (nowMs == null) return 'invalid';

  const skew = Number.isFinite(options.clockSkewMs)
    ? Number(options.clockSkewMs)
    : DEFAULT_CLOCK_SKEW_MS;

  if (parsed - nowMs > skew) {
    return 'invalid_future';
  }

  const ageMinutes = (nowMs - parsed) / 60000;
  if (ageMinutes < 0) {
    // Within skew window: treat as fresh
    return 'fresh';
  }
  return ageMinutes <= Number(maxAgeMinutes) ? 'fresh' : 'stale';
}

/**
 * Age in minutes. Future timestamps return null (not 0).
 * @param {unknown} dataTimestamp
 * @param {number|Date|string} [now]
 * @returns {number|null}
 */
export function ageMinutes(dataTimestamp, now = Date.now()) {
  const parsed = parseUtcMs(dataTimestamp);
  const nowMs = parseUtcMs(now);
  if (parsed == null || nowMs == null) return null;
  if (parsed > nowMs) return null;
  return (nowMs - parsed) / 60000;
}

/**
 * Assert pregame observation eligibility.
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function assertPregameEligible({
  observedAt = null,
  effectiveAt = null,
  asOf = null,
  firstPitch = null,
  clockSkewMs = DEFAULT_CLOCK_SKEW_MS
} = {}) {
  const asOfMs = parseUtcMs(asOf);
  if (asOfMs == null) {
    return { ok: false, reason: 'missing_as_of' };
  }

  const firstPitchMs = parseUtcMs(firstPitch);
  // Producer time is strict: a row at or after first pitch is never pregame.
  // Clock skew remains allowed only when comparing source timestamps to as_of.
  if (firstPitchMs != null && asOfMs >= firstPitchMs) {
    return {
      ok: false,
      reason: asOfMs === firstPitchMs ? 'as_of_at_first_pitch' : 'as_of_after_first_pitch'
    };
  }

  for (const [label, value] of [
    ['observed_at', observedAt],
    ['effective_at', effectiveAt]
  ]) {
    const ms = parseUtcMs(value);
    if (ms == null) continue;
    if (ms - asOfMs > clockSkewMs) {
      return { ok: false, reason: `${label}_after_as_of` };
    }
    if (firstPitchMs != null && ms - firstPitchMs > clockSkewMs) {
      return { ok: false, reason: `${label}_after_first_pitch` };
    }
  }

  return { ok: true, reason: null };
}

/**
 * Keep only game-log rows with date strictly before asOfDate (YYYY-MM-DD).
 * @param {Array<{date?: string, gameDate?: string}>} splits
 * @param {string} asOfDateYmd
 */
export function filterSplitsBeforeDate(splits, asOfDateYmd) {
  if (!asOfDateYmd) return [];
  const cutoff = String(asOfDateYmd).slice(0, 10);
  return (splits || []).filter((split) => {
    const raw = split?.date || split?.gameDate || split?.game?.gameDate || '';
    const day = String(raw).slice(0, 10);
    return day && day < cutoff;
  });
}

export const TEMPORAL_CLOCK_SKEW_MS = DEFAULT_CLOCK_SKEW_MS;
