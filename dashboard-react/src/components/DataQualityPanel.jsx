import { AlertTriangle, CheckCircle2, CircleDot, XCircle } from 'lucide-react';
import DataQualityBadge from './DataQualityBadge.jsx';
import PredictionBadge from './PredictionBadge.jsx';
import RiskFactors from './RiskFactors.jsx';
import { Progress } from './ui/form.jsx';
import { lower } from '../utils.js';

function qualityIcon(value) {
  const text = lower(value);
  if (text.includes('confirmed') || text.includes('fresh') || text.includes('available')) {
    return <CheckCircle2 size={16} className="text-emerald-600" />;
  }
  if (text.includes('projected') || text.includes('stale') || text.includes('partial')) {
    return <AlertTriangle size={16} className="text-amber-600" />;
  }
  if (text.includes('missing')) {
    return <XCircle size={16} className="text-rose-600" />;
  }
  return <CircleDot size={16} className="text-slate-400" />;
}

function CheckRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-0">
      <span className="flex items-center gap-2 text-sm text-slate-600">
        {qualityIcon(value)}
        {label}
      </span>
      <PredictionBadge>{value || 'Missing'}</PredictionBadge>
    </div>
  );
}

export default function DataQualityPanel({ quality }) {
  const score = Number(quality?.score) || 0;
  const issues = [...(quality?.issues || []), ...(quality?.stale_fields || [])];
  return (
    <div className="rounded-lg border border-line bg-slate-50 p-4">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h4 className="text-sm font-bold text-ink">Data Quality</h4>
          <p className="text-sm text-slate-500">Weak or stale inputs cap confidence and can trigger NO BET.</p>
        </div>
        <DataQualityBadge score={score} />
      </div>
      <Progress value={score} />
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <CheckRow label="Probable pitchers" value={quality?.probable_pitchers} />
          <CheckRow label="Lineup" value={quality?.lineup} />
          <CheckRow label="Weather" value={quality?.weather} />
          <CheckRow label="Odds" value={quality?.odds} />
        </div>
        <div>
          <CheckRow label="Bullpen usage" value={quality?.bullpen_usage} />
          <CheckRow label="Park factor" value={quality?.park_factor} />
          <CheckRow label="Injury/news" value={quality?.injury_news} />
          <CheckRow label="Market movement" value={quality?.market_movement} />
        </div>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <RiskFactors title="Issues" items={issues} />
        <RiskFactors title="Confidence Adjustments" items={quality?.confidence_adjustments} />
      </div>
    </div>
  );
}
