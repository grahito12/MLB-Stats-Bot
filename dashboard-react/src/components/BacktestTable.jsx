import EdgeIndicator from './EdgeIndicator.jsx';
import PredictionBadge from './PredictionBadge.jsx';
import { number, percent } from '../utils.js';
import { Card, CardContent } from './ui/card.jsx';

export default function BacktestTable({ result }) {
  const summary = result?.summary || {};
  const rows = result?.rows || [];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Bets Taken</p><strong className="text-2xl">{summary.bets_taken || 0}</strong></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">Win Rate</p><strong className="text-2xl">{percent(summary.win_rate)}</strong></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">ROI</p><strong className="text-2xl">{percent(summary.roi)}</strong></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs uppercase text-slate-500">No-Bet Count</p><strong className="text-2xl">{summary.no_bet_count || 0}</strong></CardContent></Card>
      </div>
      <Card>
        <CardContent className="grid gap-4 text-sm text-slate-600 md:grid-cols-2">
          <div>
        <p><strong>Best segment:</strong> {summary.best_segment || '-'}</p>
        <p><strong>Weakest segment:</strong> {summary.weakest_segment || '-'}</p>
        <p><strong>Calibration:</strong> {summary.calibration_summary || '-'}</p>
          </div>
          <div>
            <p><strong>Average edge:</strong> {percent(summary.average_edge)}</p>
            <p><strong>Average CLV:</strong> {number(summary.average_clv, 2)}</p>
            <p><strong>No-bet breakdown:</strong> {(result?.no_bet_reasons || []).map((item) => `${item.reason} (${item.count})`).join(', ') || 'none'}</p>
          </div>
        </CardContent>
      </Card>
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="min-w-full divide-y divide-line text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>{['Date', 'Matchup', 'Market', 'Lean', 'Result', 'Edge', 'P/L'].map((label) => <th key={label} className="px-3 py-3">{label}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row, index) => (
              <tr key={`${row.date}-${index}`} className="transition-colors hover:bg-slate-50">
                <td className="px-3 py-3">{row.date}</td>
                <td className="px-3 py-3 font-semibold">{row.matchup}</td>
                <td className="px-3 py-3">{row.market}</td>
                <td className="px-3 py-3">{row.lean}</td>
                <td className="px-3 py-3"><PredictionBadge>{row.result}</PredictionBadge></td>
                <td className="px-3 py-3"><EdgeIndicator value={row.edge} /></td>
                <td className={`px-3 py-3 font-semibold ${Number(row.profit_loss) >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{number(row.profit_loss, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
