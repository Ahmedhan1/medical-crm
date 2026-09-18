import { useState, useMemo, type FormEvent } from 'react';
import { Dialog, Input, Select, Button, Alert, useToast } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { ApiError } from '../../../lib/api/types.js';
import { recordPayment, type PaymentMethod, type PaymentResult } from '../api/finance.js';
import { formatMoney, parseMoneyToMinor } from '../format.js';

const METHODS: PaymentMethod[] = ['cash', 'card', 'bank_transfer', 'insurance', 'wallet', 'other'];

/** Record a payment against an invoice. The amount is entered in major units and
 * converted to integer minor units for the API; a per-open idempotency key makes
 * a double-click / retry safe (the backend de-dupes). The backend re-validates
 * balance/overpayment and remains authoritative. */
export function RecordPaymentDialog({
  open,
  onClose,
  invoiceId,
  balanceDueMinor,
  currency,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  invoiceId: string;
  balanceDueMinor: number;
  currency: string;
  onRecorded: (result: PaymentResult) => void;
}): JSX.Element {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Stable per-dialog-open key so a retry of THIS payment does not double-charge.
  const idempotencyKey = useMemo(
    () => `pay-${invoiceId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    [invoiceId, open],
  );

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const minor = parseMoneyToMinor(amount);
    if (minor === null || minor <= 0) { setError(t('finance.pay.invalid')); return; }
    if (minor > balanceDueMinor) { setError(t('finance.pay.tooMuch')); return; }
    setSubmitting(true);
    try {
      const result = await recordPayment(invoiceId, {
        amountMinor: minor,
        method,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
        idempotencyKey,
      });
      toast.notify(t('finance.pay.success'), 'success');
      setAmount(''); setReference(''); setMethod('cash');
      onRecorded(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('finance.err.load'));
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('finance.pay.title')} closeLabel={t('common.close')}>
      <form onSubmit={submit} noValidate>
        {error && <Alert tone="danger" role="alert">{error}</Alert>}
        <div style={{ marginBlockEnd: 8, opacity: 0.8 }}>
          {t('finance.pay.balance')}: {formatMoney(balanceDueMinor, currency, locale)}
        </div>
        <Input
          label={t('finance.pay.amount')}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          autoFocus
          required
        />
        <Select label={t('finance.pay.method')} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
          {METHODS.map((m) => <option key={m} value={m}>{t(`finance.method.${m}`)}</option>)}
        </Select>
        <Input label={t('finance.pay.reference')} value={reference} onChange={(e) => setReference(e.target.value)} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginBlockStart: 12 }}>
          <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" loading={submitting}>{t('finance.pay.submit')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
