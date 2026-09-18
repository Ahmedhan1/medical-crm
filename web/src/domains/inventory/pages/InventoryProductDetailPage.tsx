import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, Table, EmptyState, ErrorState, Skeleton, Alert, Dialog, Input, type Column } from '../../../components/ui/index.js';
import { useToast } from '../../../components/ui/index.js';
import { useAuth } from '../../../lib/auth/AuthContext.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { ApiError } from '../../../lib/api/types.js';
import { formatDateTime } from '../../../lib/format/datetime.js';
import {
  createBatch, getProduct, listLocations, listMovements,
  type InventoryLocation, type ProductDetail, type StockBalanceRow, type StockMovement,
} from '../api/inventory.js';
import { StockOpDialog, type StockOp } from '../components/StockOpDialog.js';

export function InventoryProductDetailPage(): JSX.Element {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [op, setOp] = useState<StockOp | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [nonce, setNonce] = useState(0); // bump to refetch after a mutation

  const detail = useQuery<ProductDetail>((s) => getProduct(id, s), [id, nonce]);
  const locations = useQuery<InventoryLocation[]>((s) => listLocations(s), []);
  const movements = useQuery<StockMovement[]>((s) => listMovements({ productId: id, limit: 25 }, s), [id, nonce]);

  const refresh = (): void => { setNonce((n) => n + 1); locations.refetch(); };

  if (detail.loading) return <Card><div aria-busy="true" style={{ display: 'grid', gap: 8 }}>{[0, 1, 2].map((i) => <Skeleton key={i} height={28} />)}</div></Card>;
  if (detail.error) return <Card><ErrorState title={t('inv.err.load')} body={detail.error.message} onRetry={detail.refetch} retryLabel={t('common.retry')} /></Card>;
  const data = detail.data;
  if (!data) return <Card><EmptyState title={t('inv.err.load')} /></Card>;
  const { product, balances, batches } = data;

  const total = balances.reduce((s, b) => s + b.onHand, 0);

  const balCols: Array<Column<StockBalanceRow>> = [
    { key: 'loc', header: t('inv.detail.col.location'), render: (b) => b.locationName },
    { key: 'lot', header: t('inv.detail.col.lot'), render: (b) => b.lotNumber ?? '—' },
    { key: 'exp', header: t('inv.detail.col.expiry'), render: (b) => b.expiryDate ?? '—' },
    { key: 'oh', header: t('inv.detail.col.onhand'), render: (b) => `${b.onHand} ${product.unitOfMeasure}` },
  ];
  const moveCols: Array<Column<StockMovement>> = [
    { key: 'when', header: t('inv.movements.col.when'), render: (m) => formatDateTime(m.occurredAt, locale) },
    { key: 'type', header: t('inv.movements.col.type'), render: (m) => t(`inv.op.${m.movementType.toLowerCase()}`) },
    { key: 'dir', header: t('inv.movements.col.dir'), render: (m) => <Badge tone={m.direction === 'in' ? 'success' : 'warning'}>{t(m.direction === 'in' ? 'inv.dir.in' : 'inv.dir.out')}</Badge> },
    { key: 'qty', header: t('inv.movements.col.qty'), render: (m) => String(m.quantity) },
    { key: 'after', header: t('inv.movements.col.after'), render: (m) => String(m.balanceAfter) },
    { key: 'reason', header: t('inv.movements.col.reason'), render: (m) => m.reason ?? m.reference ?? '—' },
  ];

  const opButton = (o: StockOp, perm: string): JSX.Element | null =>
    can(perm) ? <Button variant="secondary" onClick={() => setOp(o)}>{t(`inv.op.${o}`)}</Button> : null;

  return (
    <div>
      <PageHeader
        title={product.name}
        subtitle={`${product.sku} · ${product.category ?? '—'}`}
        actions={<Button variant="ghost" onClick={() => navigate('/inventory/products')}>{t('inv.detail.back')}</Button>}
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBlockEnd: 16 }}>
        {opButton('receive', 'stock:receive')}
        {opButton('issue', 'stock:issue')}
        {opButton('transfer', 'stock:transfer')}
        {opButton('adjust', 'stock:adjust')}
        {product.isBatchTracked && can('inventory:manage') && <Button variant="ghost" onClick={() => setBatchOpen(true)}>{t('inv.detail.newBatch')}</Button>}
      </div>

      <Card title={t('inv.detail.section.balances')}>
        <p style={{ margin: '0 0 8px' }}><strong>{t('inv.detail.total')}:</strong> {total} {product.unitOfMeasure}</p>
        <Table columns={balCols} rows={balances} rowKey={(b) => `${b.locationId}:${b.batchId ?? 'none'}`} empty={<EmptyState title={t('inv.detail.balances.empty')} />} />
      </Card>

      {product.isBatchTracked && (
        <Card title={t('inv.detail.section.batches')}>
          <Table
            columns={[
              { key: 'lot', header: t('inv.detail.col.lot'), render: (b) => b.lotNumber },
              { key: 'exp', header: t('inv.detail.col.expiry'), render: (b) => b.expiryDate ?? '—' },
            ]}
            rows={batches}
            rowKey={(b) => b.id}
            empty={<EmptyState title={t('inv.detail.batches.empty')} />}
          />
        </Card>
      )}

      <Card title={t('inv.detail.section.movements')}>
        {movements.loading ? <Skeleton height={80} /> : movements.error ? (
          <ErrorState title={t('inv.err.load')} body={movements.error.message} onRetry={movements.refetch} retryLabel={t('common.retry')} />
        ) : (
          <Table columns={moveCols} rows={movements.data ?? []} rowKey={(m) => m.id} empty={<EmptyState title={t('inv.detail.movements.empty')} />} />
        )}
      </Card>

      {op && (
        <StockOpDialog
          open={op !== null}
          op={op}
          product={product}
          locations={locations.data ?? []}
          batches={batches}
          onClose={() => setOp(null)}
          onDone={() => { setOp(null); refresh(); }}
        />
      )}

      <AddBatchDialog open={batchOpen} productId={product.id} requireExpiry={product.isExpiryTracked} onClose={() => setBatchOpen(false)} onDone={() => { setBatchOpen(false); toast.notify(t('inv.detail.batchCreated'), 'success'); refresh(); }} />
    </div>
  );
}

function AddBatchDialog(props: { open: boolean; productId: string; requireExpiry: boolean; onClose: () => void; onDone: () => void }): JSX.Element {
  const { t } = useI18n();
  const [lot, setLot] = useState('');
  const [expiry, setExpiry] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!lot.trim()) { setError(t('inv.form.err.name')); return; }
    setBusy(true);
    try {
      await createBatch({ productId: props.productId, lotNumber: lot.trim(), expiryDate: expiry || null });
      setLot(''); setExpiry('');
      props.onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('inv.err.load'));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={props.open} onClose={props.onClose} title={t('inv.detail.newBatch')}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Input label={t('inv.detail.col.lot')} value={lot} onChange={(e) => setLot(e.target.value)} />
        <Input label={`${t('inv.detail.col.expiry')}${props.requireExpiry ? ' *' : ''}`} type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={props.onClose}>{t('common.cancel')}</Button>
          <Button type="submit" loading={busy}>{t('inv.detail.newBatch')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
