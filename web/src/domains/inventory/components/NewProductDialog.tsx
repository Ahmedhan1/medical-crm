import { useState, type FormEvent } from 'react';
import { Dialog, Button, Alert, Input } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { ApiError } from '../../../lib/api/types.js';
import { createProduct, type InventoryProduct } from '../api/inventory.js';

/** Create an inventory product. Batch/expiry flags are opt-in; expiry implies batch. */
export function NewProductDialog(props: {
  open: boolean;
  onClose: () => void;
  onCreated: (p: InventoryProduct) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [uom, setUom] = useState('unit');
  const [batch, setBatch] = useState(false);
  const [expiry, setExpiry] = useState(false);
  const [reorder, setReorder] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset(): void {
    setSku(''); setName(''); setCategory(''); setUom('unit'); setBatch(false);
    setExpiry(false); setReorder(''); setUnitCost(''); setError(null);
  }
  function close(): void { reset(); props.onClose(); }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!sku.trim()) { setError(t('inv.form.err.sku')); return; }
    if (!name.trim()) { setError(t('inv.form.err.name')); return; }
    setBusy(true);
    try {
      const created = await createProduct({
        sku: sku.trim(), name: name.trim(),
        category: category.trim() || null,
        unitOfMeasure: uom.trim() || 'unit',
        isBatchTracked: batch || expiry,
        isExpiryTracked: expiry,
        reorderThreshold: reorder ? Number(reorder) : null,
        unitCost: unitCost ? Number(unitCost) : null,
      });
      reset();
      props.onCreated(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('inv.err.load'));
    } finally {
      setBusy(false);
    }
  }

  const checkbox = (checked: boolean, on: (v: boolean) => void, label: string): JSX.Element => (
    <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input type="checkbox" checked={checked} onChange={(e) => on(e.target.checked)} />
      <span>{label}</span>
    </label>
  );

  return (
    <Dialog open={props.open} onClose={close} title={t('inv.products.new')}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Input label={t('inv.form.sku')} value={sku} onChange={(e) => setSku(e.target.value)} />
        <Input label={t('inv.form.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <Input label={t('inv.form.category')} value={category} onChange={(e) => setCategory(e.target.value)} />
        <Input label={t('inv.form.uom')} value={uom} onChange={(e) => setUom(e.target.value)} />
        {checkbox(batch, setBatch, t('inv.form.batch'))}
        {checkbox(expiry, setExpiry, t('inv.form.expiry'))}
        <Input label={t('inv.form.reorder')} type="number" min="0" step="any" value={reorder} onChange={(e) => setReorder(e.target.value)} />
        <Input label={t('inv.form.unitCost')} type="number" min="0" step="any" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={close}>{t('common.cancel')}</Button>
          <Button type="submit" loading={busy}>{t('inv.form.submit')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
