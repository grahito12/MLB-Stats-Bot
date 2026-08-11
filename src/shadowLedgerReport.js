import { uiBullet, uiKV, uiSection, uiTitle, UI_LINE } from './telegramFormat.js';
import { summarizeClv } from './clv_gate.js';

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function fmtUnits(value) {
  const n = finite(value, 0);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}u`;
}

function fmtMetric(value, digits = 4) {
  const n = finite(value, null);
  return n == null ? 'n/a' : n.toFixed(digits);
}

function probability01(value) {
  const n = finite(value, null);
  if (n == null) return null;
  return n > 1 ? n / 100 : n;
}

function brier(rows, key) {
  const values = rows
    .map((row) => {
      const probability = probability01(row[key]);
      if (probability == null || (row.result !== 'win' && row.result !== 'loss')) return null;
      const outcome = row.result === 'win' ? 1 : 0;
      return (probability - outcome) ** 2;
    })
    .filter((value) => value != null);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Report paper decisions blocked by rolling CLV gate. Nothing here changes
 * real bankroll, real ledger, production CLV gate, model memory, or evolution.
 */
export function formatShadowLedgerReport(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const open = all.filter((row) => row.status === 'open');
  const settled = all.filter((row) => row.status === 'settled');
  const wins = settled.filter((row) => row.result === 'win').length;
  const losses = settled.filter((row) => row.result === 'loss').length;
  const pushes = settled.filter((row) => row.result === 'push').length;
  const staked = settled.reduce(
    (sum, row) => sum + finite(row.simulated_units_staked, 0),
    0
  );
  const pl = settled.reduce(
    (sum, row) => sum + finite(row.simulated_units_pl, 0),
    0
  );
  const roi = staked > 0 ? (pl / staked) * 100 : null;
  const clv = summarizeClv(settled, { market: 'moneyline', lookback: Number.MAX_SAFE_INTEGER });
  const modelBrier = brier(settled, 'model_prob');
  const marketBrier = brier(settled, 'fair_prob');

  const lines = [
    uiTitle('🧪', 'Paper / Shadow Ledger'),
    uiBullet('⚠️', 'Simulasi saja — bukan uang nyata, bukan bankroll, bukan klaim profit.'),
    '',
    uiSection('📌', 'Cakupan'),
    uiKV('🟡', 'Open', open.length),
    uiKV('🟢', 'Settled', settled.length),
    uiKV('🎯', 'Progress minimum', `${Math.min(settled.length, 50)}/50`),
    uiKV('📊', 'Progress ideal', `${Math.min(settled.length, 100)}/100`),
    ''
  ];

  if (settled.length === 0) {
    lines.push(uiBullet('—', 'Belum ada kandidat CLV-blocked yang selesai.'));
  } else {
    const record = `${wins}-${losses}${pushes ? `-${pushes}P` : ''}`;
    lines.push(
      uiSection('🧮', 'Hasil simulasi'),
      uiKV('📊', 'Record', record),
      uiKV('💰', 'Simulated stake', `${staked.toFixed(2)}u`),
      uiKV('📈', 'Simulated P/L', fmtUnits(pl)),
      uiKV('🎯', 'Simulated ROI', roi == null ? 'n/a' : `${roi > 0 ? '+' : ''}${roi.toFixed(1)}%`),
      '',
      uiSection('📉', 'Forward validation'),
      uiKV(
        '📌',
        'Avg CLV',
        clv.sample
          ? `${clv.avgClv > 0 ? '+' : ''}${clv.avgClv.toFixed(2)} (n=${clv.sample}, +${clv.positive}/-${clv.negative})`
          : 'n/a'
      ),
      uiKV('🧠', 'Model Brier', fmtMetric(modelBrier)),
      uiKV('🏦', 'Market/fair Brier', fmtMetric(marketBrier))
    );
  }

  if (open.length > 0) {
    lines.push('', uiSection('🕒', `Open terbaru (${Math.min(open.length, 5)}/${open.length})`));
    for (const row of open.slice(-5)) {
      const odds = finite(row.odds, 0);
      lines.push(
        uiBullet(
          '•',
          `${row.team || row.side} ${odds > 0 ? '+' : ''}${Math.round(odds)} | edge ${finite(row.edge, 0).toFixed(1)}% | paper ${finite(row.simulated_units_staked, 0).toFixed(2)}u`
        )
      );
    }
  }

  lines.push(
    '',
    UI_LINE,
    uiBullet('🛑', 'Shadow result tidak membuka CLV gate otomatis dan tidak masuk model memory/evolution.')
  );
  return lines.join('\n');
}
