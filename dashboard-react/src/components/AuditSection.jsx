import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Badge } from './ui/badge.jsx';
import EmptyState from './EmptyState.jsx';
import LoadingState from './LoadingState.jsx';
import PredictionAuditCard from './PredictionAuditCard.jsx';

export default function AuditSection() {
  const [date, setDate] = useState('');
  const [rows, setRows] = useState([]);
  const [warning, setWarning] = useState(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [audit, setAudit] = useState(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    api
      .auditPredictions(date ? { date, limit: 100 } : { limit: 100 })
      .then((payload) => {
        if (cancelled) return;
        setRows(payload.rows || []);
        setWarning(payload.warning || null);
      })
      .catch((err) => {
        if (!cancelled) setListError(err.message);
      })
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  useEffect(() => {
    if (!selectedId) {
      setAudit(null);
      return;
    }
    let cancelled = false;
    setAuditLoading(true);
    setAuditError(null);
    api
      .predictionAudit(selectedId)
      .then((payload) => {
        if (!cancelled) setAudit(payload);
      })
      .catch((err) => {
        if (!cancelled) setAuditError(err.message);
      })
      .finally(() => {
        if (!cancelled) setAuditLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle>Prediction Audit</CardTitle>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="glass-input w-40 px-2 py-1 text-xs font-black"
            aria-label="Filter predictions by date"
          />
        </CardHeader>
        <CardContent>
          {listLoading && <LoadingState label="Loading immutable predictions..." />}
          {listError && <EmptyState title="Failed to load predictions" message={listError} />}
          {!listLoading && !listError && warning && (
            <EmptyState title="Prediction history unavailable" message={warning} />
          )}
          {!listLoading && !listError && !warning && rows.length === 0 && (
            <EmptyState
              title="No immutable predictions"
              message={date ? `No model predictions recorded for ${date}.` : 'No model predictions recorded yet.'}
            />
          )}
          {!listLoading && rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-3 border-ink bg-accent-yellow">
                    {['Date', 'Matchup', 'Model', 'Pick', 'Prob', 'Status', 'Result', ''].map((label, i) => (
                      <th key={i} className="px-3 py-2 text-left text-[11px] font-black uppercase text-ink">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y-2 divide-ink">
                  {rows.map((row, index) => (
                    <tr
                      key={row.prediction_id}
                      className={`${row.prediction_id === selectedId ? 'bg-accent-blue' : index % 2 === 0 ? 'bg-paper' : 'bg-cream'} cursor-pointer transition-colors hover:bg-accent-yellow`}
                      onClick={() => setSelectedId(row.prediction_id === selectedId ? null : row.prediction_id)}
                    >
                      <td className="px-3 py-2 text-xs text-ink/60">{row.date || '-'}</td>
                      <td className="px-3 py-2 text-xs font-medium text-ink">{row.matchup || row.game_pk}</td>
                      <td className="px-3 py-2 text-xs text-ink/70">
                        {row.model_id}
                        <span className="text-ink/40"> {row.model_version || ''}</span>
                      </td>
                      <td className="px-3 py-2 text-xs uppercase text-ink/70">{row.pick_side || '-'}</td>
                      <td className="px-3 py-2 text-xs text-ink/70">
                        {Number.isFinite(Number(row.pick_probability)) ? `${Number(row.pick_probability).toFixed(1)}%` : '-'}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={String(row.status || '').toUpperCase() === 'VALUE' ? 'value' : 'nobet'}>
                          {row.status || '-'}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-ink/70">{row.has_result ? 'Settled' : 'Pending'}</td>
                      <td className="px-3 py-2 text-right text-[11px] font-black uppercase text-accent-blue">
                        {row.prediction_id === selectedId ? 'Close' : 'Inspect'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {auditLoading && <LoadingState label="Loading audit card..." />}
      {auditError && <EmptyState title="Failed to load audit" message={auditError} />}
      {!auditLoading && audit && <PredictionAuditCard audit={audit} />}
    </div>
  );
}
