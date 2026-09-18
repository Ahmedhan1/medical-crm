import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, ErrorState, Skeleton } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { getHcp, type Hcp } from '../api/crm.js';

const TONE: Record<Hcp['status'], 'success' | 'neutral' | 'warning'> = { active: 'success', inactive: 'neutral', retired: 'warning', merged: 'neutral' };

export function HcpDetailPage(): JSX.Element {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const navigate = useNavigate();
  const query = useQuery<Hcp & Record<string, unknown>>((s) => getHcp(id, s), [id]);

  const row = (label: string, value: string | null | undefined): JSX.Element => (
    <div style={{ display: 'flex', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--mc-border, #eee)' }}>
      <span style={{ minWidth: 120, color: 'var(--mc-muted, #666)' }}>{label}</span>
      <span>{value || t('crm.hcp.none')}</span>
    </div>
  );

  return (
    <div>
      <PageHeader
        title={query.data ? `${query.data.title ? `${query.data.title} ` : ''}${query.data.fullName}` : t('crm.hcps.title')}
        actions={<Button variant="ghost" onClick={() => navigate('/crm/hcps')}>{t('crm.hcp.back')}</Button>}
      />
      <Card title={t('crm.hcp.section.profile')}>
        {query.loading ? <Skeleton height={120} /> : query.error ? (
          <ErrorState title={t('crm.err.load')} body={query.error.message} onRetry={query.refetch} retryLabel={t('common.retry')} />
        ) : query.data ? (
          <div>
            {row(t('crm.hcp.category'), query.data.professionalCategory)}
            {row(t('crm.hcp.email'), query.data.professionalEmail)}
            {row(t('crm.hcp.phone'), query.data.professionalPhone)}
            <div style={{ display: 'flex', gap: 8, padding: '6px 0' }}>
              <span style={{ minWidth: 120, color: 'var(--mc-muted, #666)' }}>{t('crm.hcp.status')}</span>
              <Badge tone={TONE[query.data.status]}>{t(`crm.status.${query.data.status}`)}</Badge>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
