import { Loader2 } from 'lucide-react';
import { Card, CardContent } from './ui/card.jsx';

export default function LoadingState({ label = 'Loading dashboard data...' }) {
  return (
    <Card>
      <CardContent className="flex min-h-40 items-center justify-center gap-3 text-sm font-semibold text-slate-500">
        <Loader2 size={18} className="animate-spin" />
        {label}
      </CardContent>
    </Card>
  );
}
