import PredictionBadge from './PredictionBadge.jsx';
import EdgeIndicator from './EdgeIndicator.jsx';
import { number, percent } from '../utils.js';

export default function HistoryTable({ rows }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-white">
      <table className="min-w-full divide-y divide-line text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            {['Date', 'Matchup', 'Market', 'Prediction', 'Confidence', 'Prob', 'Edge', 'Close', 'Result', 'P/L', 'CLV'].map((label) => (
              <th key={label} className="px-3 py-3 font-semibold">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, index) => (
            <tr key={`${row.date}-${row.matchup}-${index}`} className="transition-colors hover:bg-slate-50">
              <td className="px-3 py-3">{row.date}</td>
              <td className="px-3 py-3 font-semibold text-ink">{row.matchup}</td>
              <td className="px-3 py-3">{row.market_type}</td>
              <td className="px-3 py-3">{row.prediction}</td>
              <td className="px-3 py-3"><PredictionBadge>{row.confidence}</PredictionBadge></td>
              <td className="px-3 py-3">{percent(row.model_probability)}</td>
              <td className="px-3 py-3"><EdgeIndicator value={row.edge} /></td>
              <td className="px-3 py-3">{row.closing_line || '-'}</td>
              <td className="px-3 py-3"><PredictionBadge>{row.result}</PredictionBadge></td>
              <td className={`px-3 py-3 font-semibold ${Number(row.profit_loss) >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{number(row.profit_loss, 2)}</td>
              <td className="px-3 py-3">{number(row.clv, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
