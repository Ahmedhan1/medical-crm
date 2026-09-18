import { useMemo, useState, type FormEvent } from 'react';
import { Dialog, Button, Alert, Input, Select } from '../../../components/ui/index.js';
import { useToast } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { ApiError } from '../../../lib/api/types.js';
import {
  adjustStock, issueStock, receiveStock, transferStock,
  type InventoryBatch, type InventoryLocation, type InventoryProduct,
} from '../api/inventory.js';

export type StockOp = 'receive' | 'issue' | 'transfer' | 'adjust';

/**
 * One dialog for every stock mutation. The backend owns all correctness
 * (row-locking, negative-stock refusal, expiry blocking, idempotency); this form
 * only collects a well-formed request and surfaces the server's response.
 */
export function StockOpDialog(props: {
  open: boolean;
  op: StockOp;
  product: InventoryProduct;
  locations: InventoryLocation[];
  batches: InventoryBatch[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const { open, op, product, locations, batches, onClose, onDone } = props;
  const { t } = useI18n();
  const toast = useToast();
  const activeLocations = useMemo(() => locations.filter((l) => l.isActive), [locations]);
  const [locationId, setLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [batchId, setBatchId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('out');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isTransfer = op === 'transfer';
  const isAdjust = op === 'adjust';

  function reset(): void {
    setLocationId(''); setToLocationId(''); setBatchId(''); setQuantity('');
    setDirection('out'); setReason(''); setReference(''); setError(null);
  }
  function close(): void { reset(); onClose(); }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) { setError(t('inv.op.err.qty')); return; }
    if (!locationId) { setError(t('inv.op.err.location')); return; }
    if (isTransfer && !toLocationId) { setError(t('inv.op.err.location')); return; }
    if (isTransfer && locationId === toLocationId) { setError(t('inv.op.err.sameLocation')); return; }
    if (isAdjust && !reason.trim()) { setError(t('inv.op.err.reason')); return; }
    if (product.isBatchTracked && !batchId) { setError(t('inv.op.batchRequired')); return; }

    const batch = product.isBatchTracked ? batchId : null;
    setBusy(true);
    try {
      if (op === 'receive') await receiveStock({ productId: product.id, locationId, batchId: batch, quantity: qty, reference: reference || null });
      else if (op === 'issue') await issueStock({ productId: product.id, locationId, batchId: batch, quantity: qty, reference: reference || null });
      else if (op === 'adjust') await adjustStock({ productId: product.id, locationId, batchId: batch, quantity: qty, direction, reason });
      else await transferStock({ productId: product.id, fromLocationId: locationId, toLocationId, batchId: batch, quantity: qty, reference: reference || null });
      toast.notify(t('inv.op.done'), 'success');
      reset();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('inv.err.load'));
    } finally {
      setBusy(false);
    }
  }

  const title = t(`inv.op.${op}`);
  return (
    <Dialog open={open} onClose={close} title={`${title} — ${product.name}`}>
      {activeLocations.length === 0 ? (
        <Alert tone="warning">{t('inv.op.noLocations')}</Alert>
      ) : (
        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          {error && <Alert tone="danger">{error}</Alert>}
          <Select label={isTransfer ? t('inv.op.fromLocation') : t('inv.op.location')} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">—</option>
            {activeLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
          {isTransfer && (
            <Select label={t('inv.op.toLocation')} value={toLocationId} onChange={(e) => setToLocationId(e.target.value)}>
              <option value="">—</option>
              {activeLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          )}
          {product.isBatchTracked && (
            <Select label={t('inv.op.batch')} value={batchId} onChange={(e) => setBatchId(e.target.value)}>
              <option value="">—</option>
              {batches.map((b) => <option key={b.id} value={b.id}>{b.lotNumber}{b.expiryDate ? ` (${b.expiryDate})` : ''}</option>)}
            </Select>
          )}
          {isAdjust && (
            <Select label={t('inv.op.direction')} value={direction} onChange={(e) => setDirection(e.target.value as 'in' | 'out')}>
              <option value="out">{t('inv.op.dir.out')}</option>
              <option value="in">{t('inv.op.dir.in')}</option>
            </Select>
          )}
          <Input label={t('inv.op.quantity')} type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          {isAdjust ? (
            <Input label={t('inv.op.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
          ) : (
            <Input label={t('inv.op.reference')} value={reference} onChange={(e) => setReference(e.target.value)} />
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button type="button" variant="ghost" onClick={close}>{t('common.cancel')}</Button>
            <Button type="submit" loading={busy}>{t('inv.op.submit')}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
