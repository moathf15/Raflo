import { Icon, type IconName } from '@riflo/ui';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { ar as t } from '../i18n/ar';
import { useServices } from './services';

const NAV: { to: string | null; icon: IconName; label: string }[] = [
  { to: '/', icon: 'chart', label: t.nav.overview },
  { to: '/content', icon: 'board', label: t.nav.content },
  { to: null, icon: 'users', label: t.nav.users },
  { to: null, icon: 'route', label: t.nav.trips },
  { to: '/reports', icon: 'flag', label: t.nav.reviews }
];

export function AdminShell({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  const { api, user, setUser } = useServices();
  return (
    <div className="adm">
      <nav className="side" aria-label="أقسام الإدارة">
        <p className="side__brand">{t.brand} <span>{t.area}</span></p>
        {NAV.map((n) =>
          n.to ? (
            <NavLink key={n.label} to={n.to} end className={({ isActive }) => (isActive ? 'side__link side__link--on' : 'side__link')}>
              <Icon name={n.icon} size={18} />
              {n.label}
            </NavLink>
          ) : (
            <span key={n.label} className="side__link side__link--soon" aria-disabled="true">
              <Icon name={n.icon} size={18} />
              {n.label}
              <small>{t.soon}</small>
            </span>
          )
        )}
        {api.auth.requiresAccount ? (
          <span className="side__sample">{user?.email}<button type="button" className="side__out" onClick={async () => { await api.auth.signOut(); setUser(null); }}>{t.auth.signOut}</button></span>
        ) : (
          <span className="side__sample">{t.sampleData}</span>
        )}
      </nav>
      <main className="adm__main">
        <header className="adm__head">
          <div>
            <h1 className="t-display">{title}</h1>
            {subtitle && <p className="t-sm muted">{subtitle}</p>}
          </div>
          {actions}
        </header>
        {children}
      </main>
    </div>
  );
}
