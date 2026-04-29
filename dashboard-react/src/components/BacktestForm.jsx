import { Download, Play } from 'lucide-react';
import { Button } from './ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.jsx';
import { Field, Input, Select } from './ui/form.jsx';

export default function BacktestForm({ form, onChange, onRun, running, exportHref }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Run Backtest</CardTitle>
        <CardDescription>Select a season or date window, then test moneyline or totals logic.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Season" helper="Leave date range blank for season-level sample backtest.">
            <Input type="number" value={form.season} onChange={(event) => onChange({ ...form, season: Number(event.target.value) })} />
          </Field>
          <Field label="Start date">
            <Input type="date" value={form.start_date} onChange={(event) => onChange({ ...form, start_date: event.target.value })} />
          </Field>
          <Field label="End date">
            <Input type="date" value={form.end_date} onChange={(event) => onChange({ ...form, end_date: event.target.value })} />
          </Field>
          <Field label="Market">
            <Select value={form.market_type} onChange={(event) => onChange({ ...form, market_type: event.target.value })}>
              <option value="moneyline">Moneyline</option>
              <option value="totals">Totals</option>
            </Select>
          </Field>
          <Button onClick={onRun} type="button">
            <Play size={16} />
            {running ? 'Running...' : 'Run backtest'}
          </Button>
          <Button asChild variant="secondary">
            <a href={exportHref}>
              <Download size={16} />
              Export CSV
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
