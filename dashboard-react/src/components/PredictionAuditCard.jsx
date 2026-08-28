import { Card, CardContent, CardHeader, CardTitle } from './ui/card.jsx';
import { Badge } from './ui/badge.jsx';
import { CheckCircle2, AlertTriangle, XCircle, HelpCircle } from 'lucide-react';

const NOT_RECORDED = 'Not recorded';

function pct(value, digits = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(digits)}%` : NOT_RECORDED;
}

// market_quote_pairs stores probabilities as 0-1 fractions; model rows use 0-100.
function fracPct(value, digits = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(digits)}%` : NOT_RECORDED;
}

function signedPts(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '-';
  return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(digits)}`;
}

function americanOdds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return NOT_RECORDED;
  return parsed > 0 ? `+${parsed}` : `${parsed}`;
}

function Field({ label, value, mono = false }) {
  const missing = value === null || value === undefined || value === '' || value === NOT_RECORDED;
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink/50 shrink-0">{label}</span>
      <span className={`text-xs text-right ${mono ? 'font-mono' : 'font-semibold'} ${missing ? 'italic text-ink/40' : 'text-ink'} break-all`}>
        {missing ? NOT_RECORDED : String(value)}
      </span>
    </div>
  );
}

function SectionBox({ title, tone = 'paper', children }) {
  const bg = { paper: 'bg-paper', green: 'bg-accent-green', yellow: 'bg-accent-yellow', red: 'bg-accent-red' }[tone] || 'bg-paper';
  return (
    <div className={`rounded-lg border-2 border-ink ${bg} p-3 shadow-neo-sm`}>
      <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-ink/70">{title}</p>
      {children}
    </div>
  );
}

function qualityIcon(state) {
  if (state === 'available' || state === 'confirmed') return <CheckCircle2 className="h-3.5 w-3.5 text-accent-green" />;
  if (state === 'fallback' || state === 'estimated' || state === 'projected' || state === 'stale') {
    return <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />;
  }
  if (state === 'missing' || state === 'ineligible') return <XCircle className="h-3.5 w-3.5 text-accent-red" />;
  return <HelpCircle className="h-3.5 w-3.5 text-ink/40" />;
}

function ProbabilityBar({ label, home, away, homeLabel, awayLabel, asFraction = false }) {
  const fmt = asFraction ? fracPct : pct;
  const homeNum = Number(home);
  const width = Number.isFinite(homeNum) ? (asFraction ? homeNum * 100 : homeNum) : null;
  return (
    <div className="py-1.5">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink/50">{label}</span>
        <span className="text-xs font-semibold text-ink">
          {awayLabel} {fmt(away)} · {homeLabel} {fmt(home)}
        </span>
      </div>
      {width !== null ? (
        <div className="h-2 w-full overflow-hidden rounded border border-ink bg-cream">
          <div className="h-full bg-accent-blue" style={{ width: `${Math.max(0, Math.min(100, 100 - width))}%` }} />
        </div>
      ) : (
        <p className="text-[11px] italic text-ink/40">{NOT_RECORDED}</p>
      )}
    </div>
  );
}

export default function PredictionAuditCard({ audit }) {
  if (!audit) return null;
  const { prediction, model, probabilities, decision, market, dataQuality, contributions, result, ledger, replay } = audit;

  const homeAbbr = prediction?.teams?.home?.abbreviation || 'HOME';
  const awayAbbr = prediction?.teams?.away?.abbreviation || 'AWAY';
  const isBet = Boolean(decision?.is_bet);
  const quote = market?.at_prediction;
  const closing = market?.closing;

  const modelHome = Number(probabilities?.calibrated_home);
  const marketHome = quote ? Number(quote.home_no_vig_probability) * 100 : NaN;
  const modelMarketDelta =
    Number.isFinite(modelHome) && Number.isFinite(marketHome) ? modelHome - marketHome : null;

  const maxAbsContribution = Math.max(
    0.0001,
    ...(contributions?.contributions || []).map((c) => Math.abs(Number(c.edge_contribution) || 0))
  );

  return (
    <Card className="animate-slide-up">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>
          {prediction?.matchup || `${awayAbbr} @ ${homeAbbr}`} — Prediction Audit
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant={isBet ? 'value' : 'nobet'}>{decision?.status || 'UNKNOWN'}</Badge>
          {dataQuality?.status && (
            <Badge variant={dataQuality.status === 'GOOD' ? 'success' : dataQuality.status === 'DEGRADED' ? 'warning' : 'danger'}>
              {dataQuality.status}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {/* Model + probabilities */}
          <SectionBox title="Model">
            <Field label="Model" value={model?.model_id} />
            <Field label="Version" value={model?.model_impl_version || model?.model_version} />
            <Field label="Feature schema" value={model?.feature_schema_version} />
            <Field label="Calibration" value={model?.calibration_version} mono />
            <Field label="Calibration status" value={model?.calibration_status} />
            <Field label="As of (UTC)" value={prediction?.as_of_utc} mono />
            <Field label="First pitch (UTC)" value={prediction?.first_pitch_utc} mono />
          </SectionBox>

          <SectionBox title="Probabilities">
            <ProbabilityBar
              label="Raw model"
              home={probabilities?.raw_home}
              away={probabilities?.raw_away}
              homeLabel={homeAbbr}
              awayLabel={awayAbbr}
            />
            <ProbabilityBar
              label="Calibrated (final)"
              home={probabilities?.calibrated_home}
              away={probabilities?.calibrated_away}
              homeLabel={homeAbbr}
              awayLabel={awayAbbr}
            />
            <ProbabilityBar
              label="Market no-vig (at prediction)"
              home={quote?.home_no_vig_probability}
              away={quote?.away_no_vig_probability}
              homeLabel={homeAbbr}
              awayLabel={awayAbbr}
              asFraction
            />
            <div className="mt-1 flex items-baseline justify-between border-t-2 border-ink/20 pt-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink/50">Model − market ({homeAbbr})</span>
              <span className={`text-sm font-black ${modelMarketDelta > 0 ? 'text-accent-green' : modelMarketDelta < 0 ? 'text-accent-red' : 'text-ink/60'}`}>
                {modelMarketDelta === null ? NOT_RECORDED : `${signedPts(modelMarketDelta, 1)} pts`}
              </span>
            </div>
          </SectionBox>

          {/* Decision */}
          <SectionBox title="Decision" tone={isBet ? 'green' : 'yellow'}>
            <div className="mb-2 flex items-center gap-2">
              <Badge variant={isBet ? 'value' : 'nobet'}>{isBet ? 'BET' : 'NO BET'}</Badge>
              <span className="text-xs font-semibold text-ink">
                {decision?.team_name || (decision?.pick_side ? `${decision.pick_side === 'home' ? homeAbbr : awayAbbr}` : '')}
                {Number.isFinite(Number(decision?.pick_probability)) ? ` @ ${pct(decision.pick_probability)}` : ''}
              </span>
            </div>
            <Field label="Edge" value={Number.isFinite(Number(decision?.edge)) ? `${signedPts(decision.edge, 1)}%` : null} />
            <Field label="Odds" value={decision?.odds != null ? `${americanOdds(decision.odds)} (${decision?.bookmaker || 'book?'})` : null} />
            <Field label="Kelly stake" value={Number.isFinite(Number(decision?.kelly_stake_percent)) ? `${decision.kelly_stake_percent}%` : null} />
            {(decision?.reasons?.length > 0 || decision?.reason_codes?.length > 0) ? (
              <div className="mt-2 border-t-2 border-ink/20 pt-2">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink/50">Why</p>
                <ul className="space-y-1 text-xs text-ink/80">
                  {(decision?.reasons || decision?.reason_codes || []).slice(0, 6).map((reason, i) => (
                    <li key={i}>• {reason}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-2 text-[11px] italic text-ink/40">Decision reason: {NOT_RECORDED}</p>
            )}
          </SectionBox>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {/* Feature contributions */}
          <SectionBox title="Feature contributions">
            {contributions?.available ? (
              <>
                <div className="space-y-1.5">
                  {contributions.contributions.map((item) => {
                    const value = Number(item.edge_contribution) || 0;
                    const widthPct = Math.min(100, (Math.abs(value) / maxAbsContribution) * 100);
                    return (
                      <div key={item.feature} className="grid grid-cols-[110px_1fr_58px] items-center gap-2">
                        <span className="truncate text-[11px] font-semibold text-ink/70" title={`${item.feature} (${item.category})`}>
                          {item.feature.replaceAll('_', ' ')}
                        </span>
                        <div className="relative h-3 rounded border border-ink/40 bg-cream">
                          <div className="absolute inset-y-0 left-1/2 w-px bg-ink/40" />
                          <div
                            className={`absolute inset-y-0 ${value >= 0 ? 'left-1/2 bg-accent-green' : 'right-1/2 bg-accent-red'}`}
                            style={{ width: `${widthPct / 2}%` }}
                          />
                        </div>
                        <span className={`text-right text-[11px] font-mono font-semibold ${value >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                          {item.probability_points != null ? `${signedPts(item.probability_points, 2)}pp` : signedPts(value, 3)}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-[10px] text-ink/50">
                  Exact edge decomposition of {model?.model_id}
                  {contributions.decomposition_complete ? ' (components sum to raw edge)' : ' (incomplete decomposition)'}.
                  {contributions.record_dominated ? ' Record-context group dampened ×0.45.' : ''} Probability points are linearized approximations.
                </p>
              </>
            ) : (
              <p className="text-xs italic text-ink/40">{contributions?.note || NOT_RECORDED}</p>
            )}
          </SectionBox>

          {/* Data quality */}
          <SectionBox title="Data quality">
            {dataQuality?.recorded ? (
              <>
                <Field label="Lineup" value={dataQuality.lineup_state} />
                <div className="mt-1 grid grid-cols-2 gap-x-3">
                  {(dataQuality.inputs || []).map((input) => (
                    <div key={input.input} className="flex items-center gap-1.5 py-0.5">
                      {qualityIcon(input.state)}
                      <span className="truncate text-[11px] text-ink/70" title={`${input.input}: ${input.state}`}>{input.input}</span>
                    </div>
                  ))}
                </div>
                {dataQuality.reasons?.length > 0 && (
                  <div className="mt-2 border-t-2 border-ink/20 pt-2">
                    <ul className="space-y-0.5 text-[11px] text-ink/70">
                      {dataQuality.reasons.map((reason, i) => <li key={i}>⚠ {reason}</li>)}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs italic text-ink/40">{NOT_RECORDED}</p>
            )}
          </SectionBox>

          {/* Market detail */}
          <SectionBox title="Market">
            {quote ? (
              <>
                <Field label="Bookmaker" value={quote.bookmaker} />
                <Field label="Odds" value={`${awayAbbr} ${americanOdds(quote.away_odds)} / ${homeAbbr} ${americanOdds(quote.home_odds)}`} />
                <Field label="Implied (raw)" value={`${fracPct(quote.away_implied_probability)} / ${fracPct(quote.home_implied_probability)}`} />
                <Field label="No-vig" value={`${fracPct(quote.away_no_vig_probability)} / ${fracPct(quote.home_no_vig_probability)}`} />
                <Field label="Quote time (UTC)" value={quote.fetched_at_utc} mono />
                <Field
                  label="Quote age at prediction"
                  value={quote.age_minutes_at_prediction != null ? `${quote.age_minutes_at_prediction} min` : null}
                />
                {market?.source === 'nearest_pre_as_of' && (
                  <p className="mt-1 text-[10px] text-ink/50">Nearest pre-prediction quote (no quote was paired to this run).</p>
                )}
              </>
            ) : (
              <p className="text-xs italic text-ink/40">No market quote at or before prediction time.</p>
            )}
          </SectionBox>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {/* Result */}
          <SectionBox title="Result" tone={result?.recorded ? (result.prediction_correct ? 'green' : 'red') : 'paper'}>
            {result?.recorded ? (
              <>
                <Field label="Final score" value={`${awayAbbr} ${result.away_score} — ${homeAbbr} ${result.home_score}`} />
                <Field label="Winner" value={result.winner_side === 'home' ? homeAbbr : result.winner_side === 'away' ? awayAbbr : null} />
                <Field
                  label="Model pick"
                  value={result.prediction_correct === null ? null : result.prediction_correct ? 'CORRECT' : 'INCORRECT'}
                />
                {closing ? (
                  <>
                    <Field label="Closing no-vig" value={`${awayAbbr} ${fracPct(closing.away_no_vig_probability)} / ${homeAbbr} ${fracPct(closing.home_no_vig_probability)}`} />
                    <Field label="Closing book" value={closing.bookmaker} />
                  </>
                ) : (
                  <Field label="Closing line" value={null} />
                )}
                {ledger ? (
                  <>
                    <Field label="Bet result" value={ledger.result || ledger.status} />
                    <Field label="Units P/L" value={ledger.units_pl != null ? signedPts(ledger.units_pl, 2) : null} />
                    <Field label="CLV" value={ledger.clv != null ? signedPts(ledger.clv, 2) : null} />
                  </>
                ) : (
                  <Field label="Bet ledger" value={isBet ? null : 'No bet placed'} />
                )}
              </>
            ) : (
              <p className="text-xs italic text-ink/40">Game not settled yet.</p>
            )}
          </SectionBox>

          {/* Identity / reproducibility */}
          <SectionBox title="Identity & replay">
            <Field label="Prediction ID" value={prediction?.prediction_id} mono />
            <Field label="Run ID" value={prediction?.run_id} mono />
            <Field label="Game PK" value={prediction?.game_pk} mono />
            <Field label="Snapshot hash" value={replay?.snapshot_hash ? `${replay.snapshot_hash.slice(0, 16)}…` : null} mono />
            <Field label="Snapshot on disk" value={replay?.snapshot_path ? (replay.snapshot_available ? 'Available' : 'Missing file') : null} />
            <Field label="Recorded at (UTC)" value={prediction?.created_at} mono />
            <Field label="Promotion eligible" value={prediction?.promotion_eligible ? 'Yes' : 'No'} />
          </SectionBox>

          {/* Closing / CLV context when unsettled */}
          {!result?.recorded && (
            <SectionBox title="Closing line">
              {closing ? (
                <>
                  <Field label="Closing book" value={closing.bookmaker} />
                  <Field label="Closing odds" value={`${awayAbbr} ${americanOdds(closing.away_odds)} / ${homeAbbr} ${americanOdds(closing.home_odds)}`} />
                  <Field label="Closing no-vig" value={`${fracPct(closing.away_no_vig_probability)} / ${fracPct(closing.home_no_vig_probability)}`} />
                </>
              ) : (
                <p className="text-xs italic text-ink/40">Closing quote not captured yet.</p>
              )}
            </SectionBox>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
