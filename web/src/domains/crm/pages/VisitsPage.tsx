import { useState } from 'react';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Badge, Card, Table, EmptyState, ErrorState, Skeleton, Select, type Column } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { formatDateTime } from '../../../lib/format/datetime.js';
import { listVisits, type Visit, type VisitStatus } from '../api/crm.js';

const TONE: Record<VisitStatus, 'success' | 'info' | 'neutral' | 'warning' | 'danger'> = {
  planned: 'info', confirmed: 'info', completed: 'success', cancelled: 'neutral', no_access: 'warning',
};
const STATUSES: VisitStatus[] = ['planned', 'confirmed', 'completed', 'cancelled', 'no_access'];

export function VisitsPage(): JSX.Element {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<VisitStatus | ''>('');
  const query = useQuery<Visit[]>((s) => listVisits(status ? { status } : {}, s), [status]);

  const columns: Array<Column<Visit>> = [
    { key: 'when', header: t('crm.visits.col.when'), render: (v) => formatDateTime(v.plannedAt, locale) },
    { key: 'subject', header: t('crm.visits.col.subject'), render: (v) => v.hcpName ?? v.hcoName ?? v.hcpId ?? v.hcoId ?? '—' },
    { key: 'modality', header: t('crm.visits.col.modality'), render: (v) => v.modality },
    { key: 'type', header: t('crm.visits.col.type'), render: (v) => v.visitType },
    { key: 'status', header: t('crm.visits.col.status'), render: (v) => <Badge tone={TONE[v.status]}>{t(`crm.vstatus.${v.status}`)}</Badge> },
  ];

  return (
    <div>
      <PageHeader title={t('crm.visits.title')} subtitle={t('crm.visits.subtitle')} />
      <Card>
        <div style={{ maxWidth: 240, marginBlockEnd: 12 }}>
          <Select label={t('crm.visits.col.status')} value={status} onChange={(e) => setStatus(e.target.value as VisitStatus | '')}>
            <option value="">{t('crm.visits.filter.all')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t(`crm.vstatus.${s}`)}</option>)}
          </Select>
        </div>
        {query.loading ? <Skeleton height={100} /> : query.error ? (
          <ErrorState title={t('crm.err.load')} body={query.error.message} onRetry={query.refetch} retryLabel={t('common.retry')} />
        ) : (
          <Table columns={columns} rows={query.data ?? []} rowKey={(v) => v.id} empty={<EmptyState title={t('crm.visits.empty.title')} body={t('crm.visits.empty.body')} />} />
        )}
      </Card>
    </div>
  );
}
