import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Badge, Card, Table, EmptyState, ErrorState, Skeleton, type Column } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { formatDateTime } from '../../../lib/format/datetime.js';
import { listMovements, type StockMovement } from '../api/inventory.js';

/** The global append-only stock movement ledger (most recent first). */
export function InventoryMovementsPage(): JSX.Element {
  const { t, locale } = useI18n();
  const query = useQuery<StockMovement[]>((s) => listMovements({ limit: 100 }, s), []);

  const columns: Array<Column<StockMovement>> = [
    { key: 'when', header: t('inv.movements.col.when'), render: (m) => formatDateTime(m.occurredAt, locale) },
    { key: 'type', header: t('inv.movements.col.type'), render: (m) => t(`inv.op.${m.movementType.toLowerCase()}`) },
    { key: 'dir', header: t('inv.movements.col.dir'), render: (m) => <Badge tone={m.direction === 'in' ? 'success' : 'warning'}>{t(m.direction === 'in' ? 'inv.dir.in' : 'inv.dir.out')}</Badge> },
    { key: 'qty', header: t('inv.movements.col.qty'), render: (m) => String(m.quantity) },
    { key: 'after', header: t('inv.movements.col.after'), render: (m) => String(m.balanceAfter) },
    { key: 'reason', header: t('inv.movements.col.reason'), render: (m) => m.reason ?? m.reference ?? '—' },
  ];

  return (
    <div>
      <PageHeader title={t('inv.movements.title')} subtitle={t('inv.movements.subtitle')} />
      <Card>
        {query.loading ? <Skeleton height={120} /> : query.error ? (
          <ErrorState title={t('inv.err.load')} body={query.error.message} onRetry={query.refetch} retryLabel={t('common.retry')} />
        ) : (
          <Table columns={columns} rows={query.data ?? []} rowKey={(m) => m.id} empty={<EmptyState title={t('inv.movements.empty.title')} body={t('inv.movements.empty.body')} />} />
        )}
      </Card>
    </div>
  );
}
