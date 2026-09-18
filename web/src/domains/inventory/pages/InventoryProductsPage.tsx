import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, Table, EmptyState, ErrorState, Skeleton, type Column } from '../../../components/ui/index.js';
import { useToast } from '../../../components/ui/index.js';
import { Input } from '../../../components/ui/index.js';
import { PermissionGate } from '../../../components/auth/guards.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { listProducts, type InventoryProduct } from '../api/inventory.js';
import { NewProductDialog } from '../components/NewProductDialog.js';

/** Inventory products: searchable list, create, and drill-in to a product. */
export function InventoryProductsPage(): JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const query = useQuery<InventoryProduct[]>((signal) => listProducts({ q: q || undefined, limit: 100 }, signal), [q]);

  function trackingLabel(p: InventoryProduct): string {
    if (p.isExpiryTracked) return t('inv.products.tracked.expiry');
    if (p.isBatchTracked) return t('inv.products.tracked.batch');
    return t('inv.products.tracked.none');
  }

  const columns: Array<Column<InventoryProduct>> = [
    { key: 'sku', header: t('inv.products.col.sku'), render: (p) => p.sku },
    { key: 'name', header: t('inv.products.col.name'), render: (p) => p.name },
    { key: 'category', header: t('inv.products.col.category'), render: (p) => p.category ?? '—' },
    { key: 'uom', header: t('inv.products.col.uom'), render: (p) => p.unitOfMeasure },
    { key: 'tracking', header: t('inv.products.col.tracking'), render: (p) => <Badge tone={p.isExpiryTracked ? 'warning' : p.isBatchTracked ? 'info' : 'neutral'}>{trackingLabel(p)}</Badge> },
    { key: 'status', header: t('inv.products.col.status'), render: (p) => <Badge tone={p.isActive ? 'success' : 'neutral'}>{t(p.isActive ? 'inv.products.active' : 'inv.products.inactive')}</Badge> },
    { key: 'ops', header: '', render: (p) => <div style={{ textAlign: 'end' }}><Button variant="ghost" onClick={() => navigate(`/inventory/products/${p.id}`)}>{t('inv.products.open')}</Button></div> },
  ];

  return (
    <div>
      <PageHeader
        title={t('inv.products.title')}
        subtitle={t('inv.products.subtitle')}
        actions={<PermissionGate permission="inventory:manage"><Button onClick={() => setNewOpen(true)}>{t('inv.products.new')}</Button></PermissionGate>}
      />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); setQ(term.trim()); }} role="search" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBlockEnd: 12 }}>
          <div style={{ flex: 1 }}><Input label={t('inv.products.search')} value={term} onChange={(e) => setTerm(e.target.value)} aria-label={t('inv.products.search')} /></div>
          <Button type="submit" variant="secondary">{t('inv.products.search')}</Button>
        </form>
        {query.loading ? (
          <div aria-busy="true" style={{ display: 'grid', gap: 8 }}>{[0, 1, 2].map((i) => <Skeleton key={i} height={28} />)}</div>
        ) : query.error ? (
          <ErrorState title={t('inv.err.load')} body={query.error.message} onRetry={query.refetch} retryLabel={t('common.retry')} />
        ) : (
          <Table columns={columns} rows={query.data ?? []} rowKey={(p) => p.id} empty={<EmptyState title={t('inv.products.empty.title')} body={t('inv.products.empty.body')} />} />
        )}
      </Card>

      <NewProductDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(p) => { setNewOpen(false); toast.notify(t('inv.products.created'), 'success'); navigate(`/inventory/products/${p.id}`); }}
      />
    </div>
  );
}
