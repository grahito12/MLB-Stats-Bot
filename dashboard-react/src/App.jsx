import { useEffect, useState } from 'react';
import { api } from './api.js';
import Layout from './components/Layout.jsx';
import HeroSection from './components/HeroSection.jsx';
import TodaySlate from './components/TodaySlate.jsx';
import PredictionDetail from './components/PredictionDetail.jsx';
import MoneylineSection from './components/MoneylineSection.jsx';
import TeamAnalytics from './components/TeamAnalytics.jsx';
import DataQualitySection from './components/DataQualitySection.jsx';
import MemorySection from './components/MemorySection.jsx';
import EvolutionView from './components/EvolutionView.jsx';
import HistorySection from './components/HistorySection.jsx';
import AuditSection from './components/AuditSection.jsx';
import LedgerSection from './components/LedgerSection.jsx';
import BacktestSection from './components/BacktestSection.jsx';
import TelegramSection from './components/TelegramSection.jsx';
import SettingsSection from './components/SettingsSection.jsx';
import LoadingScreen from './components/LoadingScreen.jsx';
import LoginPage from './LoginPage.jsx';
import { useAuth } from './useAuth.js';

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

export default function App() {
  const auth = useAuth();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [date, setDate] = useState(todayDate());
  const [selectedGame, setSelectedGame] = useState(null);
  const [todayData, setTodayData] = useState(null);
  const [evolutionData, setEvolutionData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [initialLoad, setInitialLoad] = useState(true);
  const [error, setError] = useState(null);
  const [authRequired, setAuthRequired] = useState(false);

  useEffect(() => {
    fetchToday();
  }, [date, auth.token]);

  useEffect(() => {
    api.evolution().then(setEvolutionData).catch(() => {});
  }, []);

  useEffect(() => {
    setSelectedGame(null);
  }, [activeTab]);

  function isAuthError(err) {
    return err?.status === 401 || String(err?.message || '').toLowerCase().includes('dashboard api token');
  }

  function formatLoadError(liveError, sampleError, healthError) {
    if (healthError) {
      return [
        'Dashboard API unreachable. Showing empty state.',
        'Run `npm run dashboard`, then check http://127.0.0.1:8010/health.',
        'If only the web UI is running, stop it and start the combined dashboard command.',
        `Detail: ${healthError.message}`,
      ].join('\n');
    }

    return [
      'Dashboard API is reachable, but /api/today failed. Showing empty state.',
      `Live source: ${liveError?.message || 'unknown error'}`,
      `Sample source: ${sampleError?.message || 'unknown error'}`,
    ].join('\n');
  }

  async function fetchToday() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.today({ date, source: 'live' });
      setTodayData(data);
      setAuthRequired(false);
    } catch (err) {
      if (isAuthError(err)) {
        auth.logout();
        setAuthRequired(true);
        setInitialLoad(false);
        setLoading(false);
        return;
      }
      try {
        const data = await api.today({ date, source: 'sample' });
        setTodayData(data);
      } catch (sampleError) {
        let healthError = null;
        try {
          await api.health();
        } catch (healthCheckError) {
          healthError = healthCheckError;
        }
        setTodayData({ games: [], summary: {} });
        setError(formatLoadError(err, sampleError, healthError));
      }
    } finally {
      setLoading(false);
      setInitialLoad(false);
    }
  }

  if (authRequired && !auth.isAuthenticated) {
    return (
      <LoginPage
        onLogin={(token) => {
          auth.login(token);
          setAuthRequired(false);
        }}
      />
    );
  }

  if (initialLoad) {
    return <LoadingScreen />;
  }

  const games = todayData?.games || [];
  const summary = todayData?.summary || {};

  return (
    <Layout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onRefresh={fetchToday}
      date={date}
      onDateChange={setDate}
    >
      {activeTab === 'dashboard' && (
        <div className="space-y-6 animate-fade-in">
          <HeroSection
            onRefresh={fetchToday}
            onTabChange={setActiveTab}
            summary={summary}
            loading={loading}
          />
          <TodaySlate
            games={games}
            loading={loading}
            error={error}
            onSelectGame={setSelectedGame}
          />
          {selectedGame && <PredictionDetail game={selectedGame} onClose={() => setSelectedGame(null)} />}
          <div className="grid lg:grid-cols-2 gap-6">
            <MoneylineSection games={games} />
          </div>
        </div>
      )}

      {activeTab === 'games' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-black uppercase tracking-tight text-ink">Today's Games</h2>
          <TodaySlate games={games} loading={loading} error={error} onSelectGame={setSelectedGame} />
          {selectedGame && <PredictionDetail game={selectedGame} onClose={() => setSelectedGame(null)} />}
          <TeamAnalytics game={selectedGame} />
        </div>
      )}

      {activeTab === 'moneyline' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-black uppercase tracking-tight text-ink">Moneyline Value Engine</h2>
          <MoneylineSection games={games} />
        </div>
      )}


      {activeTab === 'backtest' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-black uppercase tracking-tight text-ink">Backtest</h2>
          <BacktestSection />
        </div>
      )}

      {activeTab === 'history' && (
        <div className="space-y-6 animate-fade-in">
          <HistorySection />
        </div>
      )}

      {activeTab === 'audit' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-black uppercase tracking-tight text-ink">Prediction Audit</h2>
          <AuditSection />
        </div>
      )}

      {activeTab === 'ledger' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-black uppercase tracking-tight text-ink">Bet Ledger</h2>
          <LedgerSection />
        </div>
      )}

      {activeTab === 'memory' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-black uppercase tracking-tight text-ink">Memory & Learning</h2>
          <MemorySection />
          <EvolutionView evolution={evolutionData} />
        </div>
      )}

      {activeTab === 'telegram' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-black uppercase tracking-tight text-ink">Telegram Integration</h2>
          <TelegramSection />
        </div>
      )}

      {activeTab === 'settings' && (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-xl font-black uppercase tracking-tight text-ink">Settings</h2>
          <SettingsSection />
          <DataQualitySection />
        </div>
      )}
    </Layout>
  );
}
