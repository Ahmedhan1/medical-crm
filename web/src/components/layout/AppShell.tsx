import { type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { useI18n } from '../../lib/i18n/I18nContext.js';
import { getNavSections } from '../../lib/nav/registry.js';
import { Button } from '../ui/index.js';
import './layout.css';

function Brand(): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="mc-brand">
      <span className="mc-brand__logo" aria-hidden="true">
        M
      </span>
      <span>{t('app.name')}</span>
    </div>
  );
}

function Sidebar(): JSX.Element {
  const { t } = useI18n();
  const { can } = useAuth();
  const sections = getNavSections();
  return (
    <aside className="mc-sidebar" aria-label="Primary">
      <Brand />
      <nav>
        {sections.map((section) => {
          const items = section.items.filter((i) => !i.permission || can(i.permission));
          if (items.length === 0) return null;
          return (
            <div className="mc-nav__section" key={section.id}>
              <div className="mc-nav__title">{t(section.titleKey)}</div>
              {items.map((item) => (
                <NavLink key={item.to} to={item.to} className="mc-nav__link">
                  {t(item.labelKey)}
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

function Topbar(): JSX.Element {
  const { t, toggleLocale } = useI18n();
  const { user, logout } = useAuth();
  return (
    <header className="mc-topbar">
      <div />
      <div className="mc-topbar__actions">
        <Button variant="ghost" onClick={toggleLocale} aria-label="Toggle language">
          {t('lang.toggle')}
        </Button>
        {user && <span style={{ color: 'var(--color-text-muted)' }}>{user.username}</span>}
        <Button variant="secondary" onClick={() => void logout()}>
          {t('auth.signOut')}
        </Button>
      </div>
    </header>
  );
}

/** Authenticated application shell: sidebar + topbar + routed content. */
export function AppShell({ children }: { children?: ReactNode }): JSX.Element {
  return (
    <div className="mc-shell">
      <Sidebar />
      <Topbar />
      <main className="mc-main">
        <div className="mc-main__inner">{children ?? <Outlet />}</div>
      </main>
    </div>
  );
}
