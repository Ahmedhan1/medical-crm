import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Card, Table, EmptyState, ErrorState, Skeleton, type Column } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { listReports, type ReportDefinition } from '../api/pharma.js';

/** The catalog of governed pharma reports (read-only listing). */
export function PharmaReportsPage(): JSX.Element {
  const { t } = useI18n();
  const query = useQuery<ReportDefinition[]>((s) => listReports(s), []);

  const columns: Array<Column<ReportDefinition>> = [
    { key: 'title', header: t('ph.reports.col.title'), render: (r) => r.title },
    { key: 'desc', header: t('ph.reports.col.description'), render: (r) => r.description },
  ];

  return (
    <div>
      <PageHeader title={t('ph.reports.title')} subtitle={t('ph.reports.subtitle')} />
      <Card>
        {query.loading ? <Skeleton height={100} /> : query.error ? (
          <ErrorState title={t('ph.err.load')} body={query.error.message} onRetry={query.refetch} retryLabel={t('common.retry')} />
        ) : (
          <Table columns={columns} rows={query.data ?? []} rowKey={(r) => r.key} empty={<EmptyState title={t('ph.reports.empty.title')} body={t('ph.reports.empty.body')} />} />
        )}
      </Card>
    </div>
  );
}
