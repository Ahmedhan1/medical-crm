import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Badge, Card, Table, EmptyState, ErrorState, Skeleton, type Column } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { listContent, type ApprovedContent } from '../api/pharma.js';

const TONE = (s: string): 'success' | 'warning' | 'neutral' | 'danger' =>
  s === 'approved' ? 'success' : s === 'rejected' || s === 'withdrawn' ? 'danger' : s === 'pending' || s === 'in_review' ? 'warning' : 'neutral';

export function PharmaContentPage(): JSX.Element {
  const { t } = useI18n();
  const query = useQuery<ApprovedContent[]>((s) => listContent(s), []);

  const columns: Array<Column<ApprovedContent>> = [
    { key: 'title', header: t('ph.content.col.title'), render: (c) => c.title },
    { key: 'type', header: t('ph.content.col.type'), render: (c) => c.contentType },
    { key: 'jur', header: t('ph.content.col.jurisdiction'), render: (c) => c.jurisdiction },
    { key: 'status', header: t('ph.content.col.status'), render: (c) => <Badge tone={TONE(c.approvalStatus)}>{c.approvalStatus}</Badge> },
  ];

  return (
    <div>
      <PageHeader title={t('ph.content.title')} subtitle={t('ph.content.subtitle')} />
      <Card>
        {query.loading ? <Skeleton height={100} /> : query.error ? (
          <ErrorState title={t('ph.err.load')} body={query.error.message} onRetry={query.refetch} retryLabel={t('common.retry')} />
        ) : (
          <Table columns={columns} rows={query.data ?? []} rowKey={(c) => c.id} empty={<EmptyState title={t('ph.content.empty.title')} body={t('ph.content.empty.body')} />} />
        )}
      </Card>
    </div>
  );
}
