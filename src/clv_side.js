/**
 * CLV side must match the immutable value-bet side (ledger), not display pick.
 *
 * Priority:
 *   1. bet_ledger.side (via getLedgerSide)
 *   2. prediction.valuePick.side / teamId
 *   3. display pick only as last resort when no value stake exists
 *
 * When requireValueSide=true (VALUE bets), refuse display-pick fallback and
 * return null so callers do not mis-attribute CLV to the wrong side.
 */

export function resolveClvSide(prediction, storageRef = null, { requireValueSide = false } = {}) {
  const gamePk = String(prediction?.gamePk || '');
  if (gamePk && storageRef && typeof storageRef.getLedgerSide === 'function') {
    const fromLedger = storageRef.getLedgerSide(gamePk, 'moneyline');
    if (fromLedger === 'home' || fromLedger === 'away') return fromLedger;
  }

  const valueSide = prediction?.valuePick?.side;
  if (valueSide === 'home' || valueSide === 'away') return valueSide;

  if (prediction?.valuePick?.teamId != null) {
    if (String(prediction.valuePick.teamId) === String(prediction.home?.id)) return 'home';
    if (String(prediction.valuePick.teamId) === String(prediction.away?.id)) return 'away';
  }

  if (requireValueSide) return null;

  // Last resort: display pick (legacy non-VALUE paths only).
  if (prediction?.pick?.id == null) return null;
  return String(prediction.pick.id) === String(prediction.home?.id) ? 'home' : 'away';
}
