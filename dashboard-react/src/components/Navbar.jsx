import { Activity, RefreshCw } from 'lucide-react';
import { Button } from './ui/button.jsx';
import PredictionBadge from './PredictionBadge.jsx';
import { relativeTime } from '../utils.js';

export default function Navbar({ tabs, activeTab, onTabChange, lastUpdated, loading, onRefresh }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-canvas/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-blue-600 p-2 text-white">
            <Activity size={20} />
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">MLB Prediction Dashboard</p>
            <h1 className="text-2xl font-bold text-ink">Prediction Control Center</h1>
          </div>
        </div>
        <div className="flex flex-col gap-3 lg:items-end">
          <nav className="flex flex-wrap gap-2">
            {tabs.map((tab) => (
              <Button
                key={tab}
                variant={activeTab === tab ? 'default' : 'secondary'}
                size="sm"
                onClick={() => onTabChange(tab)}
                type="button"
              >
                {tab}
              </Button>
            ))}
          </nav>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <PredictionBadge>{loading ? 'Loading' : 'Ready'}</PredictionBadge>
            <span>Last updated {relativeTime(lastUpdated)}</span>
            <Button variant="ghost" size="sm" type="button" onClick={onRefresh}>
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
              Refresh
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
