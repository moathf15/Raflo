import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Button, ErrorBox, Field, Loading } from './components/ui';
import { api, useAction, useApi } from './lib/api';
import { useI18n } from './lib/i18n';
import { connectLive, disconnectLive, onLive, useLiveConnected } from './lib/live';
import { ApprovalsPage } from './pages/Approvals';
import { AuditPage } from './pages/Audit';
import { DashboardPage } from './pages/Dashboard';
import { EmployeesPage } from './pages/Employees';
import { GitHubPage } from './pages/GitHub';
import { KnowledgePage } from './pages/Knowledge';
import { MeetingRoomPage, MeetingsPage, NewMeetingPage } from './pages/Meetings';
import { MessagesPage } from './pages/Messages';
import { OfficePage } from './pages/OfficePage';
import { ProjectsPage } from './pages/Projects';
import { ReportsPage } from './pages/Reports';
import { SettingsPage } from './pages/Settings';
import { TaskDetailPage } from './pages/TaskDetail';
import { TasksPage } from './pages/Tasks';

interface AuthState {
  needsSetup: boolean;
  me: { id: string; email: string; role: 'owner' | 'viewer' } | null;
}

export function App() {
  const state = useApi<AuthState>('/auth/state');
  useEffect(() => {
    const h = () => void state.reload();
    window.addEventListener('hq:unauthorized', h);
    return () => window.removeEventListener('hq:unauthorized', h);
  }, [state]);
  useEffect(() => {
    if (state.data?.me) connectLive();
    else disconnectLive();
  }, [state.data?.me]);
  if (state.loading && !state.data) return <Loading />;
  if (!state.data) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (!state.data.me) return <SignIn needsSetup={state.data.needsSetup} onDone={state.reload} />;
  return <Shell me={state.data.me} onSignOut={state.reload} />;
}

function SignIn({ needsSetup, onDone }: { needsSetup: boolean; onDone: () => void }) {
  const { t, lang, setLang } = useI18n();
  const [f, setF] = useState({ email: '', password: '', name: '', setupCode: '' });
  const act = useAction();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await act.run(() => api(needsSetup ? '/auth/setup' : '/auth/login', { body: needsSetup ? f : { email: f.email, password: f.password } }));
    if (ok) onDone();
  };
  return (
    <div className="signin">
      <form className="signin-card" onSubmit={submit}>
        <div className="brand-mark big" aria-hidden>
          R
        </div>
        <h1>{t.appName}</h1>
        <p className="muted">{needsSetup ? 'Create the owner account. The setup code is printed in the HQ API log.' : 'Sign in as the owner.'}</p>
        {needsSetup ? (
          <>
            <Field label="Name">
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" required />
            </Field>
            <Field label="Setup code">
              <input value={f.setupCode} onChange={(e) => setF({ ...f, setupCode: e.target.value })} required />
            </Field>
          </>
        ) : null}
        <Field label="Email">
          <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="username" required />
        </Field>
        <Field label="Password" hint={needsSetup ? 'At least 12 characters.' : undefined}>
          <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete={needsSetup ? 'new-password' : 'current-password'} required minLength={needsSetup ? 12 : 1} />
        </Field>
        <ErrorBox error={act.error} />
        <Button variant="primary" disabled={act.busy} type="submit">
          {needsSetup ? 'Create owner' : 'Sign in'}
        </Button>
        <button type="button" className="link-btn" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>
          {lang === 'ar' ? 'English' : 'العربية'}
        </button>
      </form>
    </div>
  );
}

const NAV: { to: string; key: keyof ReturnType<typeof useI18n>['t']['nav']; icon: string }[] = [
  { to: '/', key: 'office', icon: '▦' },
  { to: '/dashboard', key: 'dashboard', icon: '◔' },
  { to: '/tasks', key: 'tasks', icon: '☰' },
  { to: '/meetings', key: 'meetings', icon: '◎' },
  { to: '/messages', key: 'messages', icon: '✉' },
  { to: '/approvals', key: 'approvals', icon: '✓' },
  { to: '/employees', key: 'employees', icon: '☺' },
  { to: '/projects', key: 'projects', icon: '◫' },
  { to: '/knowledge', key: 'knowledge', icon: '❖' },
  { to: '/github', key: 'github', icon: '⎇' },
  { to: '/reports', key: 'reports', icon: '▤' },
  { to: '/settings', key: 'settings', icon: '⚙' },
  { to: '/audit', key: 'audit', icon: '⌕' }
];

function Shell({ me, onSignOut }: { me: NonNullable<AuthState['me']>; onSignOut: () => void }) {
  const { t, lang, setLang } = useI18n();
  const connected = useLiveConnected();
  const approvals = useApi<unknown[]>('/approvals', ['approvals.changed', 'notification', 'task']);
  const notes = useApi<{ id: string; title: string; body: string; link: string | null; read_at: string | null; created_at: string }[]>('/notifications', ['notification']);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<{ title: string; link: string | null } | null>(null);
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => {
    setMenu(false);
  }, [loc.pathname]);
  useEffect(
    () =>
      onLive((e) => {
        if (e.type !== 'notification') return;
        const n = e.notification as { title: string; link: string | null };
        setToast(n);
        window.setTimeout(() => setToast((cur) => (cur === n ? null : cur)), 6000);
      }),
    []
  );
  const unread = (notes.data ?? []).filter((n) => !n.read_at).length;
  return (
    <div className={`shell${menu ? ' menu-open' : ''}`}>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            R
          </span>
          <span className="brand-text">{t.appName}</span>
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} end={n.to === '/'}>
                <span className="nav-icon" aria-hidden>
                  {n.icon}
                </span>
                <span>{t.nav[n.key]}</span>
                {n.key === 'approvals' && approvals.data?.length ? <span className="badge">{approvals.data.length}</span> : null}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">
          <span className={`live-dot${connected ? ' on' : ''}`} aria-hidden />
          <span className="small">{connected ? t.common.live : t.common.offline}</span>
        </div>
      </nav>
      <div className="main-col">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMenu(!menu)} aria-label="Menu" aria-expanded={menu}>
            ☰
          </button>
          <div className="grow" />
          <Notifications notes={notes.data ?? []} unread={unread} onRead={() => void api('/notifications/read', { body: {} }).then(notes.reload)} />
          <button className="lang-btn" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')} aria-label="Language">
            {lang === 'ar' ? 'EN' : 'ع'}
          </button>
          <span className="small muted me">{me.email}</span>
          <Button small variant="ghost" onClick={() => void api('/auth/logout', { body: {} }).then(onSignOut)}>
            {t.common.signOut}
          </Button>
        </header>
        <main id="main" tabIndex={-1}>
          <Routes>
            <Route path="/" element={<OfficePage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
            <Route path="/meetings" element={<MeetingsPage />} />
            <Route path="/meetings/new" element={<NewMeetingPage />} />
            <Route path="/meetings/:id" element={<MeetingRoomPage />} />
            <Route path="/messages" element={<MessagesPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/employees" element={<EmployeesPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/knowledge" element={<KnowledgePage />} />
            <Route path="/github" element={<GitHubPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="*" element={<p className="page">Not found</p>} />
          </Routes>
        </main>
      </div>
      {toast ? (
        <button className="toast" onClick={() => (toast.link ? nav(toast.link) : undefined, setToast(null))} role="status">
          {toast.title}
        </button>
      ) : null}
    </div>
  );
}

function Notifications({ notes, unread, onRead }: { notes: { id: string; title: string; body: string; link: string | null; read_at: string | null; created_at: string }[]; unread: number; onRead: () => void }) {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  return (
    <div className="notif">
      <button className="icon-btn" onClick={() => setOpen(!open)} aria-label={`Notifications (${unread} unread)`} aria-expanded={open}>
        🔔{unread ? <span className="badge">{unread}</span> : null}
      </button>
      {open ? (
        <div className="notif-panel" role="menu">
          <div className="row between">
            <strong>Notifications</strong>
            <button className="link-btn" onClick={onRead}>
              Mark all read
            </button>
          </div>
          {notes.length ? (
            notes.slice(0, 30).map((n) => (
              <button
                key={n.id}
                className={`notif-item${n.read_at ? '' : ' unread'}`}
                onClick={() => {
                  setOpen(false);
                  if (n.link) nav(n.link);
                }}
              >
                <span>{n.title}</span>
                {n.body ? <span className="small muted clamp">{n.body}</span> : null}
              </button>
            ))
          ) : (
            <p className="muted small">Nothing yet.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function Page({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <header className="page-head">
        <h1>{title}</h1>
        {actions ? <div className="row gap-2 wrap">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}
