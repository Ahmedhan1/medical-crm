import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Card } from '../../../components/ui/index.js';
import { useAuth } from '../../../lib/auth/AuthContext.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';

/** Pharma landing page: links into the medication master, content and reports,
 * shown only for the sections the caller can access. */
export function PharmaDashboardPage(): JSX.Element {
  const { t } = useI18n();
  const { can } = useAuth();
  const navigate = useNavigate();

  const tile = (titleKey: string, bodyKey: string, to: string, perm: string): JSX.Element | null =>
    can(perm) ? (
      <Card title={t(titleKey)}>
        <p style={{ marginBlockStart: 0 }}>{t(bodyKey)}</p>
        <Button variant="secondary" onClick={() => navigate(to)}>{t('ph.dash.open')}</Button>
      </Card>
    ) : null;

  return (
    <div>
      <PageHeader title={t('ph.dash.title')} subtitle={t('ph.dash.subtitle')} />
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        {tile('ph.dash.medications', 'ph.dash.medications.body', '/pharma/medications', 'medication:read')}
        {tile('ph.dash.content', 'ph.dash.content.body', '/pharma/content', 'content:read')}
        {tile('ph.dash.reports', 'ph.dash.reports.body', '/pharma/reports', 'medication:read')}
      </div>
    </div>
  );
}
