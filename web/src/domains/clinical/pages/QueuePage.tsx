import { Link } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import {
  Button,
  Badge,
  Card,
  Table,
  EmptyState,
  ErrorState,
  Skeleton,
  type Column,
} from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { formatDateTime } from '../../../lib/format/datetime.js';
import { getQueue, type QueueEntry } from '../api/clinical.js';

/** Live clinical queue: patients currently checked in, oldest first. Read-only
 * here (gated by `queue:read`); check-in happens from the Patients workspace. */
export function QueuePage(): JSX.Element {
  const { t, locale } = useI18n();
  const query = useQuery<QueueEntry[]>((signal) => getQueue(signal), []);

  const columns: Array<Column<QueueEntry>> = [
    { key: 'mrn', header: t('clinical.queue.col.mrn'), render: (q) => q.mrn },
    {
      key: 'patient',
      header: t('clinical.queue.col.patient'),
      render: (q) => <Link to={`/clinical/patients/${q.patientId}`}>{q.patientName}</Link>,
    },
    {
      key: 'status',
      header: t('clinical.queue.col.status'),
      render: (q) => <Badge tone="info">{q.status}</Badge>,
    },
    {
      key: 'since',
      header: t('clinical.queue.col.since'),
      render: (q) => formatDateTime(q.checkedInAt, locale),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t('clinical.queue.title')}
        subtitle={t('clinical.queue.subtitle')}
        actions={
          <Button variant="secondary" onClick={query.refetch}>
            {t('common.retry')}
          </Button>
        }
      />
      <Card>
        {query.loading ? (
          <div aria-busy="true" aria-label={t('common.loading')} style={{ display: 'grid', gap: 8 }}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={28} />
            ))}
          </div>
        ) : query.error ? (
          <ErrorState
            title={query.error.isForbidden ? t('clinical.forbidden') : t('clinical.err.load')}
            body={query.error.isForbidden ? undefined : query.error.message}
            onRetry={query.error.isForbidden ? undefined : query.refetch}
            retryLabel={t('common.retry')}
          />
        ) : (
          <Table
            columns={columns}
            rows={query.data ?? []}
            rowKey={(q) => q.id}
            empty={
              <EmptyState title={t('clinical.queue.empty.title')} body={t('clinical.queue.empty.body')} />
            }
          />
        )}
      </Card>
    </div>
  );
}
