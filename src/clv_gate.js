/**
 * Rolling average CLV gate + pure summary helpers.
 *
 * Reporting always uses settled rows with a non-null CLV.
 * Gating (optional) blocks new VALUE bets when recent average CLV is
 * clearly negative with enough sample — selection quality signal, not a
 * model-probability massage.
 */

export const DEFAULT_CLV_GATE = {
  enabled: true,
  minSample: 20,
  // Block when rolling avg CLV is strictly below this (percent-implied units).
  minAvgClv: 0,
  // Look at most this many most-recent settled moneyline CLV rows.
  lookback: 50
};

function num(value, fallback = null) {
  // Number(null) === 0 — reject null/undefined/'' so missing CLV stays missing.
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Summarize CLV from ledger-like rows.
 * @param {Array<{status?:string, market?:string, clv?:number|null}>} rows
 * @param {{market?:string, lookback?:number}} [opts]
 */
export function summarizeClv(rows, opts = {}) {
  const market = opts.market || 'moneyline';
  const lookback = Math.max(1, Number(opts.lookback) || DEFAULT_CLV_GATE.lookback);
  const all = Array.isArray(rows) ? rows : [];
  const settled = all.filter(
    (r) =>
      String(r?.status || '') === 'settled' &&
      (market == null || String(r?.market || 'moneyline') === market) &&
      num(r?.clv, null) != null
  );
  // Prefer most-recent when rows carry recommended_at / settled_at ordering;
  // callers should pass already-ordered newest-last or we take the tail.
  const window = settled.slice(-lookback);
  const sample = window.length;
  const avgClv =
    sample > 0 ? window.reduce((sum, r) => sum + num(r.clv, 0), 0) / sample : null;
  const positive = window.filter((r) => num(r.clv, 0) > 0).length;
  const negative = window.filter((r) => num(r.clv, 0) < 0).length;
  return {
    market,
    sample,
    coverage: sample,
    avgClv: avgClv == null ? null : Math.round(avgClv * 1000) / 1000,
    positive,
    negative,
    lookback
  };
}

/**
 * Decide whether rolling CLV should block new VALUE bets.
 * Returns null when gate is inactive / insufficient sample / avg OK.
 * Returns a reason string when VALUE should be downgraded.
 */
export function clvGateReason(summary, config = {}) {
  const enabled = config.enabled !== false && config.enabled !== 0 && config.enabled !== '0';
  if (!enabled) return null;
  const minSample = Math.max(1, Number(config.minSample) || DEFAULT_CLV_GATE.minSample);
  const minAvgClv = num(config.minAvgClv, DEFAULT_CLV_GATE.minAvgClv);
  if (minAvgClv == null) return null;

  const sample = Number(summary?.sample) || 0;
  const avgClv = num(summary?.avgClv, null);
  if (sample < minSample) return null;
  if (avgClv == null) return null;
  if (avgClv >= minAvgClv) return null;

  const avgText = `${avgClv > 0 ? '+' : ''}${avgClv.toFixed(2)}`;
  const floorText = `${minAvgClv > 0 ? '+' : ''}${Number(minAvgClv).toFixed(2)}`;
  return `rolling avg CLV ${avgText} < ${floorText} (n=${sample})`;
}

/**
 * Apply CLV gate onto a prediction already run through applyMoneylineValueMarket.
 * Mutates betDecision in place when status is VALUE and gate fires.
 * Never changes model probabilities / edge math / pick identity.
 */
export function applyClvGateToPrediction(prediction, summary, config = {}) {
  if (!prediction?.betDecision) return prediction;
  if (prediction.betDecision.status !== 'VALUE') return prediction;
  const reason = clvGateReason(summary, config);
  if (!reason) return prediction;

  const reasons = Array.isArray(prediction.betDecision.reasons)
    ? [...prediction.betDecision.reasons]
    : [];
  if (!reasons.includes(reason)) reasons.unshift(reason);

  prediction.betDecision = {
    ...prediction.betDecision,
    status: 'NO BET',
    reason,
    reasons,
    clvGate: {
      blocked: true,
      avgClv: summary?.avgClv ?? null,
      sample: summary?.sample ?? 0,
      reason
    }
  };
  return prediction;
}
