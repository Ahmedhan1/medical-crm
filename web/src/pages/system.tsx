import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth/AuthContext.js';
import { useI18n } from '../lib/i18n/I18nContext.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { Card, EmptyState } from '../components/ui/index.js';

/** Platform landing page. Domains add their own dashboards/widgets via routes. */
export function DashboardPage(): JSX.Element {
  const { t } = useI18n();
  const { user } = useAuth();
  return (
    <div>
      <PageHeader title={t('nav.dashboard')} subtitle={user ? `@${user.username}` : undefined} />
      <Card title={t('app.name')}>
        <EmptyState
          title={t('state.empty.title')}
          body="Domain teams (Clinical, AI, Pharma) register their workspaces here."
        />
      </Card>
    </div>
  );
}

export function NotFoundPage(): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="mc-auth-layout">
      <Card title={t('error.notFound.title')}>
        <p>{t('error.notFound.body')}</p>
        <Link to="/">{t('nav.dashboard')}</Link>
      </Card>
    </div>
  );
}

export function ForbiddenPage(): JSX.Element {
  const { t } = useI18n();
  return (
    <div>
      <PageHeader title={t('error.forbidden.title')} />
      <Card>
        <EmptyState title={t('error.forbidden.title')} body={t('error.forbidden.body')} />
      </Card>
    </div>
  );
}
