import { useState } from 'react';
import { Camera, LayoutDashboard, Sparkles } from 'lucide-react';
import { ReportsEnhancerTab } from './components/ReportsEnhancerTab';
import { SalesforceDashboardTab } from './components/SalesforceDashboardTab';

type ActiveTab = 'salesforce' | 'reports';

export function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('salesforce');

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* Mobile-First Minimal Header */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200/90">
        <div className="max-w-5xl mx-auto px-3 sm:px-6 py-2.5 sm:h-16 flex flex-col sm:flex-row items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 self-start sm:self-auto">
            <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white flex items-center justify-center shadow-xs">
              <Sparkles className="w-4 h-4" />
            </div>
            <h1 className="text-sm sm:text-base font-extrabold tracking-tight text-slate-900">
              DocuDash Studio
            </h1>
          </div>

          {/* 2-Tab Navigation Switcher (Full-width & easy to tap on mobile) */}
          <nav
            aria-label="Primary Tabs"
            className="w-full sm:w-auto grid grid-cols-2 sm:inline-flex items-center rounded-xl bg-slate-100 p-1 border border-slate-200/80"
          >
            <button
              type="button"
              onClick={() => setActiveTab('salesforce')}
              className={`inline-flex items-center justify-center gap-2 min-h-[40px] px-3 sm:px-4 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
                activeTab === 'salesforce'
                  ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-200/60'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <LayoutDashboard className="w-4 h-4 text-sky-600 shrink-0" />
              <span className="truncate">Salesforce Dashboard</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('reports')}
              className={`inline-flex items-center justify-center gap-2 min-h-[40px] px-3 sm:px-4 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
                activeTab === 'reports'
                  ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-200/60'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Camera className="w-4 h-4 text-emerald-600 shrink-0" />
              <span className="truncate">Reports</span>
            </button>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-3 sm:px-6 py-4 sm:py-6">
        <div className={activeTab === 'salesforce' ? 'block' : 'hidden'}>
          <SalesforceDashboardTab />
        </div>

        <div className={activeTab === 'reports' ? 'block' : 'hidden'}>
          <ReportsEnhancerTab />
        </div>
      </main>
    </div>
  );
}

export default App;
