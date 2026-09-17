import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import './layout.css';

export interface Crumb {
  label: ReactNode;
  to?: string;
}

/** Breadcrumbs + page title/subtitle + optional actions. Shared page chrome so
 * every domain page looks consistent. */
export function PageHeader({
  title,
  subtitle,
  crumbs,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div>
      {crumbs && crumbs.length > 0 && (
        <nav className="mc-breadcrumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="mc-breadcrumbs__sep" aria-hidden="true" />}
              {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
            </Fragment>
          ))}
        </nav>
      )}
      <div className="mc-page-header">
        <div>
          <h1 className="mc-page-header__title">{title}</h1>
          {subtitle && <div className="mc-page-header__subtitle">{subtitle}</div>}
        </div>
        {actions && <div className="mc-topbar__actions">{actions}</div>}
      </div>
    </div>
  );
}
