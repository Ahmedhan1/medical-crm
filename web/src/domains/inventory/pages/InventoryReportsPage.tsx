import { useState } from 'react';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Badge, Card, Table, Tabs, EmptyState, ErrorState, Skeleton, type Column } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { lowStock, valuation, type LowStockRow, type ValuationRow } from '../api/inventory.js';

/** Inventory reports: low-stock (vs persisted thresholds) and valuation. */
export function InventoryReportsPage(): JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<'low' | 'valuation'>('low');
  const low = useQuery<LowStockRow[]>((s) => lowStock(s), []);
  const val = useQuery<{ rows: ValuationRow[]; totalValue: number }>((s) => valuation(s), []);

  const lowCols: Array<Column<LowStockRow>> = [
    { key: 'name', header: t('inv.reports.low.col.name'), render: (r) => `${r.name} (${r.sku})` },
    { key: 'oh', header: t('inv.reports.low.col.onhand'), render: (r) => <Badge tone={r.onHand <= 0 ? 'danger' : 'warning'}>{`${r.onHand} ${r.unitOfMeasure}`}</Badge> },
    { key: 'th', header: t('inv.reports.low.col.threshold'), render: (r) => String(r.reorderThreshold) },
    { key: 'ro', header: t('inv.reports.low.col.reorder'), render: (r) => r.reorderQuantity === null ? '—' : String(r.reorderQuantity) },
  ];
  const valCols: Array<Column<ValuationRow>> = [
    { key: 'name', header: t('inv.reports.val.col.name'), render: (r) => `${r.name} (${r.sku})` },
    { key: 'oh', header: t('inv.reports.val.col.onhand'), render: (r) => String(r.onHand) },
    { key: 'cost', header: t('inv.reports.val.col.cost'), render: (r) => r.unitCost === null ? '—' : r.unitCost.toFixed(2) },
    { key: 'value', header: t('inv.reports.val.col.value'), render: (r) => r.stockValue === null ? '—' : r.stockValue.toFixed(2) },
  ];

  return (
    <div>
      <PageHeader title={t('inv.reports.title')} subtitle={t('inv.reports.subtitle')} />
      <Tabs
        items={[{ id: 'low', label: t('inv.reports.tab.low') }, { id: 'valuation', label: t('inv.reports.tab.valuation') }]}
        active={tab}
        onChange={(id) => setTab(id as 'low' | 'valuation')}
      />
      <Card>
        {tab === 'low' ? (
          low.loading ? <Skeleton height={80} /> : low.error ? (
            <ErrorState title={t('inv.err.load')} body={low.error.message} onRetry={low.refetch} retryLabel={t('common.retry')} />
          ) : (
            <Table columns={lowCols} rows={low.data ?? []} rowKey={(r) => r.productId} empty={<EmptyState title={t('inv.reports.low.empty')} />} />
          )
        ) : val.loading ? <Skeleton height={80} /> : val.error ? (
          <ErrorState title={t('inv.err.load')} body={val.error.message} onRetry={val.refetch} retryLabel={t('common.retry')} />
        ) : (
          <>
            <p style={{ margin: '0 0 8px' }}><strong>{t('inv.reports.val.total')}:</strong> {(val.data?.totalValue ?? 0).toFixed(2)}</p>
            <Table columns={valCols} rows={val.data?.rows ?? []} rowKey={(r) => r.productId} empty={<EmptyState title={t('inv.reports.val.empty')} />} />
          </>
        )}
      </Card>
    </div>
  );
}
