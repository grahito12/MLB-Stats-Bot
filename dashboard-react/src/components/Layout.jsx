import Navbar from './Navbar.jsx';

export default function Layout({ tabs, activeTab, onTabChange, lastUpdated, loading, onRefresh, children }) {
  return (
    <main className="min-h-screen bg-canvas">
      <Navbar
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={onTabChange}
        lastUpdated={lastUpdated}
        loading={loading}
        onRefresh={onRefresh}
      />
      <div className="mx-auto max-w-7xl px-4 py-5">{children}</div>
    </main>
  );
}
