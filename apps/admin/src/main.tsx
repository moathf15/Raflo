import '@riflo/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, MemoryRouter, Route, Routes } from 'react-router-dom';
import './app/admin.css';
import { AdminGate } from './app/AdminGate';
import { ServicesProvider } from './app/services';
import { ContentBoardPage } from './features/content/ContentBoardPage';
import { OverviewPage } from './features/overview/OverviewPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { ar as t } from './i18n/ar';

// Hash routes on a real host; in-memory routes for the embedded preview (VITE_ROUTER=memory).
const Router = import.meta.env.VITE_ROUTER === 'memory' ? MemoryRouter : HashRouter;
// The admin never runs on sample data in production (audit 6.1).
const configured = !!import.meta.env.VITE_API_URL || import.meta.env.DEV || import.meta.env.VITE_ALLOW_MOCK === 'true';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {configured ? (
      <ServicesProvider>
        <AdminGate>
          <Router>
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/content" element={<ContentBoardPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="*" element={<OverviewPage />} />
            </Routes>
          </Router>
        </AdminGate>
      </ServicesProvider>
    ) : (
      <main role="alert" style={{ maxWidth: 460, margin: '20vh auto', padding: 24, textAlign: 'center', display: 'grid', gap: 8 }}>
        <h1 className="t-h2">{t.configError.title}</h1>
        <p className="t-body muted">{t.configError.body}</p>
      </main>
    )}
  </StrictMode>
);
