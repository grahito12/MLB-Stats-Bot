import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { number, percent } from '../utils.js';
import PerformanceCard from './PerformanceCard.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.jsx';

function SmallTable({ title, rows, columns }) {
  return (
    <Card>
      <CardContent>
      <h3 className="mb-3 text-sm font-bold text-ink">{title}</h3>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500">
            <tr>{columns.map((column) => <th key={column.key} className="py-2 pr-4">{column.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-t border-line">
                {columns.map((column) => <td key={column.key} className="py-2 pr-4">{column.render ? column.render(row[column.key], row) : row[column.key]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </CardContent>
    </Card>
  );
}

function ChartCard({ title, description, children }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <div className="h-64">{children}</div>
      </CardContent>
    </Card>
  );
}

export default function PerformanceSummary({ performance }) {
  const overall = performance?.overall || {};
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <PerformanceCard label="Bets Taken" value={overall.bets_taken || 0} helper="Settled model plays" />
        <PerformanceCard label="Win Rate" value={percent(overall.win_rate)} helper="Win/loss only" />
        <PerformanceCard label="ROI" value={percent(overall.roi)} helper="Per one-unit stake" />
        <PerformanceCard label="Average Edge" value={percent(overall.average_edge)} helper="Model vs market" />
        <PerformanceCard label="Average CLV" value={number(overall.average_clv, 2)} helper="Closing line value" />
        <PerformanceCard label="Brier Score" value={number(overall.brier_score, 3)} helper="Probability accuracy" />
        <PerformanceCard label="Log Loss" value={number(overall.log_loss, 3)} helper="Penalty for overconfidence" />
        <PerformanceCard label="CLV Hit Rate" value={percent(overall.clv_hit_rate)} helper="Beat close rate" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Performance by Market" description="Higher ROI is better, but sample size matters.">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={performance?.by_market || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="market" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} />
              <Tooltip />
              <Bar dataKey="roi" name="ROI %" fill="#2563eb" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Calibration" description="Actual win rate should track expected probability over time.">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={performance?.calibration || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="bucket" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} />
              <Tooltip />
              <Line dataKey="expected" name="Expected %" stroke="#64748b" strokeWidth={2} dot={false} />
              <Line dataKey="actual" name="Actual %" stroke="#16a34a" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <SmallTable
          title="Performance by Market"
          rows={performance?.by_market || []}
          columns={[
            { key: 'market', label: 'Market' },
            { key: 'bets', label: 'Bets' },
            { key: 'win_rate', label: 'Win Rate', render: percent },
            { key: 'roi', label: 'ROI', render: percent },
          ]}
        />
        <SmallTable
          title="Performance by Total Range"
          rows={performance?.by_total_range || []}
          columns={[
            { key: 'range', label: 'Range' },
            { key: 'bets', label: 'Bets' },
            { key: 'win_rate', label: 'Win Rate', render: percent },
            { key: 'roi', label: 'ROI', render: percent },
          ]}
        />
      </div>
      <SmallTable
        title="Calibration"
        rows={performance?.calibration || []}
        columns={[
          { key: 'bucket', label: 'Bucket' },
          { key: 'predictions', label: 'Predictions' },
          { key: 'expected', label: 'Expected', render: percent },
          { key: 'actual', label: 'Actual', render: percent },
        ]}
      />
    </div>
  );
}
