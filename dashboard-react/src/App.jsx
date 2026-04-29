import { CalendarDays, CircleAlert, CircleSlash, Gauge, Target, Trophy } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, exportUrl } from './api.js';
import { lower, signed } from './utils.js';
import BacktestForm from './components/BacktestForm.jsx';
import BacktestTable from './components/BacktestTable.jsx';
import EmptyState from './components/EmptyState.jsx';
import FilterToolbar from './components/FilterToolbar.jsx';
import GameCard from './components/GameCard.jsx';
import HistoryTable from './components/HistoryTable.jsx';
import Layout from './components/Layout.jsx';
import LoadingState from './components/LoadingState.jsx';
import PerformanceSummary from './components/PerformanceSummary.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import SummaryCard from './components/SummaryCard.jsx';
import { Button } from './components/ui/button.jsx';
import { Card, CardContent } from './components/ui/card.jsx';
import { Field, Input, Select } from './components/ui/form.jsx';

const tabs = ['Today', 'History', 'Backtest', 'Performance', 'Settings'];
const filters = [
  ['all', 'All games'],
  ['BET', 'BET'],
  ['LEAN', 'LEAN'],
  ['NO BET', 'NO BET'],
  ['high_edge', 'High edge'],
  ['stale', 'Stale data'],
  ['pitchers', 'Confirmed pitchers'],
  ['lineups', 'Confirmed lineups'],
  ['totals', 'Totals only'],
  ['moneyline', 'Moneyline only'],
];
const sorts = [
  ['time', 'Game time'],
  ['highest_edge', 'Highest edge'],
  ['moneyline_edge', 'Moneyline edge'],
  ['total_edge', 'Total edge'],
  ['confidence', 'Confidence'],
  ['quality', 'Data quality score'],
  ['total_diff', 'Projected total difference'],
  ['movement', 'Market movement'],
];

function useDashboardData() {
  const [today, setToday] = useState(null);
  const [history, setHistory] = useState([]);
  const [performance, setPerformance] = useState(null);
  const [settings, setSettings] = useState(null);
  const [backtest, setBacktest] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [source, setSource] = useState('live');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  async function loadToday(nextSource = source) {
    setLoading(true);
    setError('');
    try {
      setToday(await api.today({ source: nextSource, date }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadAll() {
    setLoading(true);
    setError('');
    try {
      const [todayPayload, historyPayload, performancePayload, settingsPayload] = await Promise.all([
        api.today({ source, date }),
        api.history(),
        api.performance(),
        api.settings(),
      ]);
      setToday(todayPayload);
      setHistory(historyPayload.rows || []);
      setPerformance(performancePayload);
      setSettings(settingsPayload);
      setBacktest(await api.backtest({ season: new Date().getFullYear(), market_type: 'moneyline' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    if (!settings?.auto_refresh_minutes) return undefined;
    const interval = setInterval(() => loadToday(), Math.max(5, Number(settings.auto_refresh_minutes)) * 60000);
    return () => clearInterval(interval);
  }, [settings?.auto_refresh_minutes, source, date]);

  return {
    today,
    history,
    performance,
    settings,
    setSettings,
    backtest,
    setBacktest,
    loading,
    error,
    source,
    setSource,
    date,
    setDate,
    loadToday,
    loadAll,
  };
}

function filterGames(games, filter) {
  if (filter === 'all') return games;
  if (['BET', 'LEAN', 'NO BET'].includes(filter)) return games.filter((game) => game.decision === filter);
  if (filter === 'high_edge') return games.filter((game) => Math.max(Math.abs(Number(game.moneyline?.edge) || 0), Math.abs(Number(game.totals?.edge) || 0)) >= 4);
  if (filter === 'stale') return games.filter((game) => lower(game.data_quality?.weather).includes('stale') || lower(game.data_quality?.odds).includes('stale'));
  if (filter === 'pitchers') return games.filter((game) => lower(game.probable_pitchers?.status).includes('confirmed'));
  if (filter === 'lineups') return games.filter((game) => lower(game.lineup_status).includes('confirmed'));
  if (filter === 'totals') return games.filter((game) => lower(game.final_lean).includes('over') || lower(game.final_lean).includes('under'));
  if (filter === 'moneyline') return games.filter((game) => !lower(game.final_lean).includes('over') && !lower(game.final_lean).includes('under'));
  return games;
}

function sortGames(games, sort) {
  const confidenceScore = { high: 3, medium: 2, low: 1 };
  const copy = [...games];
  copy.sort((a, b) => {
    if (sort === 'moneyline_edge') return Math.abs(Number(b.moneyline?.edge) || 0) - Math.abs(Number(a.moneyline?.edge) || 0);
    if (sort === 'total_edge') return Math.abs(Number(b.totals?.edge) || 0) - Math.abs(Number(a.totals?.edge) || 0);
    if (sort === 'highest_edge') {
      const edgeB = Math.max(Math.abs(Number(b.moneyline?.edge) || 0), Math.abs(Number(b.totals?.edge) || 0));
      const edgeA = Math.max(Math.abs(Number(a.moneyline?.edge) || 0), Math.abs(Number(a.totals?.edge) || 0));
      return edgeB - edgeA;
    }
    if (sort === 'confidence') return (confidenceScore[lower(b.moneyline?.confidence)] || 0) - (confidenceScore[lower(a.moneyline?.confidence)] || 0);
    if (sort === 'quality') return (Number(b.data_quality?.score) || 0) - (Number(a.data_quality?.score) || 0);
    if (sort === 'total_diff') return Math.abs(Number(b.totals?.difference) || 0) - Math.abs(Number(a.totals?.difference) || 0);
    if (sort === 'movement') return lower(b.data_quality?.market_movement).localeCompare(lower(a.data_quality?.market_movement));
    return String(a.game_time || '').localeCompare(String(b.game_time || ''));
  });
  return copy;
}

function TodayView({ today, source, setSource, date, setDate, loadToday, loading }) {
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('time');
  const games = useMemo(() => sortGames(filterGames(today?.games || [], filter), sort), [today, filter, sort]);
  const highestEdge = useMemo(() => {
    const edges = (today?.games || []).flatMap((game) => [
      Math.abs(Number(game.moneyline?.edge) || 0),
      Math.abs(Number(game.totals?.edge) || 0),
    ]);
    return edges.length ? Math.max(...edges) : 0;
  }, [today]);
  const hasWeakData = (today?.games || []).some((game) =>
    ['missing', 'stale', 'unavailable'].some((token) =>
      [game.data_quality?.lineup, game.data_quality?.weather, game.data_quality?.odds].some((value) => lower(value).includes(token))
    )
  );
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <SummaryCard label="Games Today" value={today?.summary?.total_games || 0} helper="Current slate" icon={CalendarDays} />
        <SummaryCard label="BET" value={today?.summary?.bet_count || 0} helper="High edge + quality" icon={Trophy} />
        <SummaryCard label="LEAN" value={today?.summary?.lean_count || 0} helper="Watchlist only" icon={Target} />
        <SummaryCard label="NO BET" value={today?.summary?.no_bet_count || 0} helper="Protected by QC" icon={CircleSlash} />
        <SummaryCard label="Avg Quality" value={`${today?.summary?.average_data_quality || 0}/100`} helper="Data trust score" icon={Gauge} />
        <SummaryCard label="Highest Edge" value={signed(highestEdge, '%')} helper="Largest absolute edge" icon={CircleAlert} />
      </div>

      <FilterToolbar
        filters={filters}
        activeFilter={filter}
        onFilterChange={setFilter}
        sort={sort}
        sorts={sorts}
        onSortChange={setSort}
        source={source}
        onSourceChange={setSource}
        date={date}
        onDateChange={setDate}
        loading={loading}
        onRefresh={() => loadToday(source)}
        exportHref={exportUrl('today', { source, date })}
      />
      {today?.warning ? <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">{today.warning}</p> : null}
      {hasWeakData ? <p className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">Some games have missing, unavailable, or stale context. Predictions are intentionally conservative.</p> : null}

      <div className="space-y-4">
        {loading && !games.length ? <LoadingState label="Loading today's MLB games..." /> : null}
        {!loading && !games.length ? <EmptyState title="No games found" message="No games matched the selected date, source, or filter." /> : null}
        {games.map((game) => <GameCard key={game.id} game={game} />)}
      </div>
    </div>
  );
}

function HistoryView({ history }) {
  const [filters, setFilters] = useState({
    start: '',
    end: '',
    market: 'all',
    result: 'all',
    confidence: 'all',
    decision: 'all',
  });
  const rows = history.filter((row) => {
    if (filters.start && row.date < filters.start) return false;
    if (filters.end && row.date > filters.end) return false;
    if (filters.market !== 'all' && lower(row.market_type) !== filters.market) return false;
    if (filters.result !== 'all' && lower(row.result) !== filters.result) return false;
    if (filters.confidence !== 'all' && lower(row.confidence) !== filters.confidence) return false;
    if (filters.decision !== 'all' && row.decision !== filters.decision) return false;
    return true;
  });
  return (
    <section className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Start"><Input type="date" value={filters.start} onChange={(event) => setFilters({ ...filters, start: event.target.value })} /></Field>
            <Field label="End"><Input type="date" value={filters.end} onChange={(event) => setFilters({ ...filters, end: event.target.value })} /></Field>
            <Field label="Market"><Select value={filters.market} onChange={(event) => setFilters({ ...filters, market: event.target.value })}><option value="all">All</option><option value="moneyline">Moneyline</option><option value="totals">Totals</option><option value="run line">Run line</option></Select></Field>
            <Field label="Result"><Select value={filters.result} onChange={(event) => setFilters({ ...filters, result: event.target.value })}><option value="all">All</option><option value="win">Win</option><option value="loss">Loss</option><option value="push">Push</option></Select></Field>
            <Field label="Confidence"><Select value={filters.confidence} onChange={(event) => setFilters({ ...filters, confidence: event.target.value })}><option value="all">All</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></Select></Field>
            <Field label="Decision"><Select value={filters.decision} onChange={(event) => setFilters({ ...filters, decision: event.target.value })}><option value="all">All</option><option value="BET">BET</option><option value="LEAN">LEAN</option><option value="NO BET">NO BET</option></Select></Field>
            <Button asChild variant="secondary"><a href={exportUrl('history')}>Export CSV</a></Button>
          </div>
        </CardContent>
      </Card>
      {rows.length ? <HistoryTable rows={rows} /> : <EmptyState title="No history rows" message="No prediction history matched the selected filters." />}
    </section>
  );
}

function BacktestView({ backtest, setBacktest }) {
  const [form, setForm] = useState({ season: new Date().getFullYear(), market_type: 'moneyline', start_date: '', end_date: '' });
  const [running, setRunning] = useState(false);
  async function run() {
    setRunning(true);
    try {
      setBacktest(await api.backtest(form));
    } finally {
      setRunning(false);
    }
  }
  return (
    <section className="space-y-4">
      <BacktestForm form={form} onChange={setForm} onRun={run} running={running} exportHref={exportUrl('backtest')} />
      <BacktestTable result={backtest} />
    </section>
  );
}

export default function App() {
  const data = useDashboardData();
  const [activeTab, setActiveTab] = useState('Today');
  const [saving, setSaving] = useState(false);

  async function saveSettings() {
    setSaving(true);
    try {
      await api.saveSettings(data.settings);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Layout
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      lastUpdated={data.today?.last_updated}
      loading={data.loading}
      onRefresh={() => data.loadToday(data.source)}
    >
        {data.error ? <div className="mb-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">{data.error}</div> : null}
        {activeTab === 'Today' ? <TodayView {...data} /> : null}
        {activeTab === 'History' ? <HistoryView history={data.history} /> : null}
        {activeTab === 'Backtest' ? <BacktestView backtest={data.backtest} setBacktest={data.setBacktest} /> : null}
        {activeTab === 'Performance' ? <PerformanceSummary performance={data.performance} /> : null}
        {activeTab === 'Settings' ? <SettingsPanel settings={data.settings || {}} onChange={data.setSettings} onSave={saveSettings} saving={saving} /> : null}
        <p className="mt-4 text-xs text-slate-500">Auto-refresh is conservative and uses the configured interval. Source: {data.source}.</p>
    </Layout>
  );
}
