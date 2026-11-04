import '@riflo/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './app/app.css';
import { t } from './i18n';

const root = createRoot(document.getElementById('root')!);
// A production build must be pointed at the API, or explicitly marked as a sample-data preview (audit 6.1).
const configured = !!import.meta.env.VITE_API_URL || import.meta.env.DEV || import.meta.env.VITE_ALLOW_MOCK === 'true';

root.render(
  <StrictMode>
    {configured ? (
      <App />
    ) : (
      <main role="alert" style={{ maxWidth: 420, margin: '20vh auto', padding: 24, textAlign: 'center', display: 'grid', gap: 8 }}>
        <h1 className="t-h2">{t.configError.title}</h1>
        <p className="t-body muted">{t.configError.body}</p>
      </main>
    )}
  </StrictMode>
);
