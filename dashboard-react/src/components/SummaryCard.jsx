import { ArrowUpRight } from 'lucide-react';
import { Card, CardContent } from './ui/card.jsx';

export default function SummaryCard({ label, value, helper, icon: Icon = ArrowUpRight }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-bold text-ink">{value}</p>
            {helper ? <p className="mt-1 text-xs text-slate-500">{helper}</p> : null}
          </div>
          <div className="rounded-md bg-slate-100 p-2 text-slate-500">
            <Icon size={16} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
