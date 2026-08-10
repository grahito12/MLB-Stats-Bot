import { uiBullet, uiKV, uiSection, uiTitle, UI_LINE } from './telegramFormat.js';
import { summarizeClv, clvGateReason, DEFAULT_CLV_GATE } from './clv_gate.js';

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function fmtUnits(value) {
  const n = num(value);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}u`;
}

function fmtOdds(value) {
  const n = num(value);
  return `${n > 0 ? '+' : ''}${Math.round(n)}`;
}

function fmtClv(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'n/a';
  const n = Number(value);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

// Render the bet ledger for /ledger. Fixed-notional bankroll (default 100u):
// units_staked is already a % of bankroll, so it doubles as units. ROI is
// stake-weighted: total P/L over total staked. Also reports rolling avg CLV.
export function formatLedgerReport(rows, { bankrollUnits = 100, clvGate = null } = {}) {
  const all = Array.isArray(rows) ? rows : [];
  if (all.length === 0) {
    return [
      uiTitle('📒', 'Bet Ledger'),
      '',
      uiBullet('💤', 'Belum ada VALUE bet tercatat. Jalankan /picks saat ada value pick.')
    ].join('\n');
  }

  const open = all.filter((r) => r.status === 'open');
  const settled = all.filter((r) => r.status === 'settled');
  const gateConfig = { ...DEFAULT_CLV_GATE, ...(clvGate || {}) };
  const clvSummary = summarizeClv(all, { market: 'moneyline', lookback: gateConfig.lookback });
  const gateBlocked = Boolean(clvGateReason(clvSummary, gateConfig));

  const lines = [uiTitle('📒', 'Bet Ledger'), uiKV('🏦', 'Bankroll', `${bankrollUnits}u notional (¼-Kelly)`), ''];

  // Open bets
  lines.push(uiSection('🟡', `Open (${open.length})`));
  if (open.length === 0) {
    lines.push(uiBullet('—', 'Tidak ada bet terbuka.'));
  } else {
    for (const r of open) {
      lines.push(uiBullet('•', `${r.team} ${fmtOdds(r.odds)}  |  edge +${num(r.edge).toFixed(1)}%  |  stake ${num(r.units_staked).toFixed(2)}u  (${r.date_ymd})`));
    }
  }
  lines.push('');

  // Settled record
  const wins = settled.filter((r) => r.result === 'win').length;
  const losses = settled.filter((r) => r.result === 'loss').length;
  const pushes = settled.filter((r) => r.result === 'push').length;
  const staked = settled.reduce((sum, r) => sum + num(r.units_staked), 0);
  const pl = settled.reduce((sum, r) => sum + num(r.units_pl), 0);
  const roi = staked > 0 ? (pl / staked) * 100 : 0;

  lines.push(uiSection('🟢', `Settled (${settled.length})`));
  if (settled.length === 0) {
    lines.push(uiBullet('—', 'Belum ada bet yang selesai.'));
  } else {
    const recordParts = [`${wins}-${losses}`];
    if (pushes) recordParts.push(`${pushes}P`);
    lines.push(uiKV('📊', 'Record', recordParts.join('-')));
    lines.push(uiKV('💰', 'Units staked', `${staked.toFixed(2)}u`));
    lines.push(uiKV('📈', 'Units P/L', fmtUnits(pl)));
    lines.push(uiKV('🎯', 'ROI', `${roi > 0 ? '+' : ''}${roi.toFixed(1)}%`));
  }
  lines.push('');

  // Rolling CLV (selection quality; used by VALUE gate)
  lines.push(uiSection('📉', 'CLV (moneyline)'));
  if (!clvSummary.sample) {
    lines.push(uiBullet('—', 'Belum ada settled CLV.'));
  } else {
    lines.push(
      uiKV(
        '📌',
        'Avg CLV',
        `${fmtClv(clvSummary.avgClv)} (n=${clvSummary.sample}, +${clvSummary.positive}/-${clvSummary.negative})`
      )
    );
    lines.push(
      uiKV(
        '🚪',
        'VALUE gate',
        gateBlocked
          ? `BLOCK (avg ${fmtClv(clvSummary.avgClv)} < ${fmtClv(gateConfig.minAvgClv)}, n≥${gateConfig.minSample})`
          : clvSummary.sample < gateConfig.minSample
            ? `open (sample ${clvSummary.sample}<${gateConfig.minSample})`
            : 'open'
      )
    );
  }
  lines.push('');

  // By market (only moneyline today, but future-proofed)
  const markets = [...new Set(settled.map((r) => r.market))];
  if (markets.length > 1) {
    lines.push(uiSection('🧮', 'By market'));
    for (const m of markets) {
      const mr = settled.filter((r) => r.market === m);
      const mStaked = mr.reduce((s, r) => s + num(r.units_staked), 0);
      const mPl = mr.reduce((s, r) => s + num(r.units_pl), 0);
      const mRoi = mStaked > 0 ? (mPl / mStaked) * 100 : 0;
      lines.push(uiBullet('•', `${m}: ${fmtUnits(mPl)} on ${mStaked.toFixed(2)}u (${mRoi > 0 ? '+' : ''}${mRoi.toFixed(1)}%)`));
    }
    lines.push('');
  }

  lines.push(UI_LINE);
  return lines.join('\n');
}
