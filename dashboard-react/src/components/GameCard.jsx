import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { number, percent } from '../utils.js';
import ConfidenceBadge from './ConfidenceBadge.jsx';
import DataFreshnessBadge from './DataFreshnessBadge.jsx';
import DataQualityPanel from './DataQualityPanel.jsx';
import EdgeIndicator from './EdgeIndicator.jsx';
import MarketComparison from './MarketComparison.jsx';
import NoBetReason from './NoBetReason.jsx';
import PredictionBadge from './PredictionBadge.jsx';
import RiskFactors from './RiskFactors.jsx';
import DataQualityBadge from './DataQualityBadge.jsx';
import { Button } from './ui/button.jsx';
import { Card, CardContent } from './ui/card.jsx';

export default function GameCard({ game }) {
  const [open, setOpen] = useState(false);
  const moneyline = game.moneyline || {};
  const totals = game.totals || {};
  return (
    <Card className={game.decision === 'NO BET' ? 'border-rose-100' : ''}>
      <CardContent className="p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <PredictionBadge>{game.decision}</PredictionBadge>
            <ConfidenceBadge value={moneyline.confidence} />
            <DataQualityBadge score={game.data_quality?.score || 0} />
            <DataFreshnessBadge value={game.freshness_status} />
          </div>
          <h3 className="text-xl font-bold text-ink">{game.away_team} @ {game.home_team}</h3>
          <p className="mt-1 text-sm text-slate-500">{game.game_time} | {game.ballpark} | {game.status}</p>
        </div>
        <div className="min-w-48 rounded-lg bg-slate-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Final Decision</p>
          <p className="mt-1 text-lg font-bold text-ink">{game.decision} - {game.final_lean}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-line bg-white p-3">
          <p className="text-xs font-semibold uppercase text-slate-500">Probable Pitchers</p>
          <p className="mt-2 text-sm text-ink">{game.probable_pitchers?.away}</p>
          <p className="text-sm text-ink">{game.probable_pitchers?.home}</p>
          <div className="mt-2"><PredictionBadge>{game.probable_pitchers?.status}</PredictionBadge></div>
        </div>
        <div className="rounded-lg border border-line bg-white p-3">
          <p className="text-xs font-semibold uppercase text-slate-500">Statuses</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <PredictionBadge>{game.lineup_status}</PredictionBadge>
            <PredictionBadge>{game.weather_status}</PredictionBadge>
            <PredictionBadge>{game.odds_status}</PredictionBadge>
          </div>
          <p className="mt-2 text-sm text-slate-500">{game.weather_summary}</p>
        </div>
        <div className="rounded-lg border border-line bg-white p-3">
          <p className="text-xs font-semibold uppercase text-slate-500">Moneyline</p>
          <p className="mt-2 text-sm">{game.away_team}: <strong>{percent(moneyline.away_probability)}</strong></p>
          <p className="text-sm">{game.home_team}: <strong>{percent(moneyline.home_probability)}</strong></p>
          <p className="mt-2 text-sm">Edge: <EdgeIndicator value={moneyline.edge} /></p>
        </div>
        <div className="rounded-lg border border-line bg-white p-3">
          <p className="text-xs font-semibold uppercase text-slate-500">Total Runs</p>
          <p className="mt-2 text-sm">Projected: <strong>{number(totals.projected_total)}</strong></p>
          <p className="text-sm">Market: <strong>{number(totals.market_total)}</strong></p>
          <p className="text-sm">Lean: <strong>{totals.lean}</strong></p>
        </div>
      </div>

      <NoBetReason reason={game.no_bet_reason} />

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_0.8fr]">
        <RiskFactors title="Main Factors" items={game.main_factors} />
        <div className="rounded-lg border border-line bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Risk Count</p>
          <p className="mt-2 text-2xl font-bold text-ink">{(game.risk_factors || []).length}</p>
          <p className="mt-1 text-sm text-slate-500">{(game.risk_factors || [])[0] || 'No major risk note'}</p>
        </div>
      </div>

      <Button
        variant="secondary"
        type="button"
        className="mt-4"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        {open ? 'Hide details' : 'Show market and quality details'}
      </Button>

      {open ? (
        <div className="mt-4 space-y-4">
          <MarketComparison game={game} />
          <div className="grid gap-4 lg:grid-cols-2">
            <DataQualityPanel quality={game.data_quality} />
            <RiskFactors title="Risk Factors" items={game.risk_factors} />
          </div>
        </div>
      ) : null}
      </CardContent>
    </Card>
  );
}
