import { Icon, type IconName } from '@riflo/ui';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { t } from '../i18n';
import { usingMock } from './services';

const TABS: { to: string; icon: IconName; label: string }[] = [
  { to: '/', icon: 'home', label: t.nav.home },
  { to: '/explore', icon: 'compass', label: t.nav.explore },
  { to: '/passport', icon: 'passport', label: t.nav.passport }
];

/** Phone-width column, centered on larger screens. `nav` adds the bottom tab bar. */
export function Screen({ children, nav, footer }: { children: ReactNode; nav?: boolean; footer?: ReactNode }) {
  return (
    <div className="screen">
      {usingMock && <div className="sample-bar">{t.sampleData}</div>}
      <main className="screen__main">{children}</main>
      {footer && <div className="screen__footer">{footer}</div>}
      {nav && (
        <nav className="tabbar" aria-label="التنقل الرئيسي">
          {TABS.map((tab) => (
            <NavLink key={tab.to} to={tab.to} end={tab.to === '/'} className={({ isActive }) => (isActive ? 'tab tab--on' : 'tab')}>
              <Icon name={tab.icon} size={22} />
              {tab.label}
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}

export function TopBar({ title, subtitle, onBack, children }: { title: string; subtitle?: string; onBack: () => void; children?: ReactNode }) {
  return (
    <header className="topbar">
      <button type="button" className="rf-icon-btn rf-icon-btn--bare" aria-label={t.common.back} onClick={onBack}>
        <Icon name="back" />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 className="t-label">{title}</h1>
        {subtitle && <p className="t-cap muted">{subtitle}</p>}
      </div>
      {children}
    </header>
  );
}
