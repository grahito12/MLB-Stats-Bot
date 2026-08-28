import { Activity, Calendar, RefreshCw, Send, Zap } from 'lucide-react';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'games', label: 'Games' },
  { id: 'moneyline', label: 'Moneyline' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'history', label: 'History' },
  { id: 'audit', label: 'Audit' },
  { id: 'memory', label: 'Memory' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'settings', label: 'Settings' },
];

function NavButton({ item, activeTab, onTabChange }) {
  const active = activeTab === item.id;
  return (
    <button
      onClick={() => onTabChange(item.id)}
      className={`whitespace-nowrap rounded-md border-2 border-ink px-3 py-1.5 text-xs font-black uppercase tracking-tight text-ink transition-all duration-150 ${
        active
          ? 'bg-accent-yellow shadow-neo-sm'
          : 'bg-paper hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-accent-blue hover:shadow-neo-sm'
      }`}
    >
      {item.label}
    </button>
  );
}

export default function Navbar({ activeTab, onTabChange, onRefresh, date, onDateChange }) {
  return (
    <nav className="glass-navbar sticky top-0 z-50">
      <div className="mx-auto max-w-[1600px] px-4">
        <div className="flex min-h-16 items-center justify-between gap-4 py-3">
          <div className="flex min-w-0 items-center gap-5">
            <div className="flex items-center gap-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-md border-3 border-ink bg-accent-red shadow-neo-sm">
                <Activity className="h-5 w-5 text-ink" />
              </div>
              <span className="hidden text-sm font-black uppercase tracking-tight text-ink sm:block">MLB Stats Bot</span>
            </div>

            <div className="hidden items-center gap-2 overflow-x-auto lg:flex">
              {NAV_ITEMS.map((item) => (
                <NavButton key={item.id} item={item} activeTab={activeTab} onTabChange={onTabChange} />
              ))}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <div className="hidden items-center gap-2 sm:flex">
              <Calendar className="h-4 w-4 text-ink" />
              <input
                type="date"
                value={date}
                onChange={(e) => onDateChange(e.target.value)}
                className="glass-input w-36 px-2 py-1 text-xs font-black"
              />
            </div>

            <button
              onClick={onRefresh}
              className="flex h-9 w-9 items-center justify-center rounded-md border-3 border-ink bg-accent-green text-ink shadow-neo-sm transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-neo active:translate-x-0.5 active:translate-y-0.5 active:shadow-none"
            >
              <RefreshCw className="h-4 w-4" />
            </button>

            <div className="hidden items-center gap-2 md:flex">
              <span className="inline-flex items-center gap-1.5 rounded-md border-2 border-ink bg-accent-green px-2 py-1 text-[10px] font-black uppercase text-ink shadow-neo-sm">
                <Send className="h-3 w-3" />
                TG
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-md border-2 border-ink bg-accent-blue px-2 py-1 text-[10px] font-black uppercase text-ink shadow-neo-sm">
                <Zap className="h-3 w-3" />
                Agent
              </span>
            </div>
          </div>
        </div>

        <div className="lg:hidden pb-3">
          <select
            value={activeTab}
            onChange={(e) => onTabChange(e.target.value)}
            className="glass-input w-full px-3 py-2 text-xs font-black uppercase"
            aria-label="Select section"
          >
            {NAV_ITEMS.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </div>
      </div>
    </nav>
  );
}
