import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Card, Button, Alert, Input, EmptyState, useToast } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { ApiError } from '../../../lib/api/types.js';
import { searchPatients, createInvoice, type PatientSummary, type ItemInput } from '../api/finance.js';
import { formatMoney, parseMoneyToMinor } from '../format.js';

interface DraftLine {
  description: string;
  quantity: string;
  price: string;
  discount: string;
}
const emptyLine = (): DraftLine => ({ description: '', quantity: '1', price: '', discount: '0' });

export function InvoiceCreatePage(): JSX.Element {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<PatientSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function doSearch(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (term.trim().length < 2) return;
    setSearching(true);
    try {
      setResults(await searchPatients(term.trim()));
    } catch (err) {
      toast.notify(err instanceof ApiError ? err.message : t('finance.err.load'), 'error');
    } finally {
      setSearching(false);
    }
  }

  function setLine(idx: number, patch: Partial<DraftLine>): void {
    setLines((cur) => cur.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  // Client-side PREVIEW only (subtotal net of discount). The backend recomputes
  // and is authoritative — this never persists or drives a decision.
  const previewMinor = lines.reduce((sum, l) => {
    const price = parseMoneyToMinor(l.price) ?? 0;
    const disc = parseMoneyToMinor(l.discount) ?? 0;
    const qty = Number(l.quantity) || 0;
    return sum + Math.max(0, qty * price - disc);
  }, 0);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!patient) { setError(t('finance.create.needPatient')); return; }
    const items: ItemInput[] = [];
    for (const l of lines) {
      const price = parseMoneyToMinor(l.price);
      const disc = parseMoneyToMinor(l.discount) ?? 0;
      const qty = Number(l.quantity);
      if (!l.description.trim() || price === null || !Number.isInteger(qty) || qty < 1) continue;
      items.push({ description: l.description.trim(), quantity: qty, unitPriceMinor: price, discountMinor: disc });
    }
    if (items.length === 0) { setError(t('finance.create.needLine')); return; }
    setSubmitting(true);
    try {
      const invoice = await createInvoice({ patientId: patient.id, items });
      toast.notify(t('finance.create.success'), 'success');
      navigate(`/finance/invoices/${invoice.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('finance.err.load'));
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader title={t('finance.create.title')} crumbs={[{ label: t('finance.nav.invoices'), to: '/finance/invoices' }]} />

      <Card title={t('finance.create.patient')}>
        {patient ? (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <strong>{patient.fullName}</strong>
            <span style={{ opacity: 0.7 }}>{patient.mrn}</span>
            <Button variant="ghost" onClick={() => { setPatient(null); setResults(null); }}>{t('common.cancel')}</Button>
          </div>
        ) : (
          <>
            <form onSubmit={doSearch} role="search" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <Input label={t('common.search')} value={term} onChange={(e) => setTerm(e.target.value)} placeholder={t('finance.create.patient.search')} type="search" />
              </div>
              <Button type="submit" loading={searching} disabled={term.trim().length < 2}>{t('common.search')}</Button>
            </form>
            {results && (
              results.length === 0 ? <EmptyState title={t('finance.inv.empty.title')} /> : (
                <ul style={{ listStyle: 'none', padding: 0, marginBlockStart: 8, display: 'grid', gap: 4 }}>
                  {results.map((p) => (
                    <li key={p.id}>
                      <Button variant="ghost" onClick={() => { setPatient(p); setResults(null); }}>{p.fullName} · {p.mrn}</Button>
                    </li>
                  ))}
                </ul>
              )
            )}
          </>
        )}
      </Card>

      <div style={{ marginBlockStart: 16 }}>
        <Card title={t('finance.detail.items')}>
          <form onSubmit={submit} noValidate>
            {error && <Alert tone="danger" role="alert">{error}</Alert>}
            {lines.map((l, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 0.6fr 1fr 1fr auto', gap: 8, alignItems: 'flex-end', marginBlockEnd: 8 }}>
                <Input label={i === 0 ? t('finance.create.line.desc') : undefined} aria-label={t('finance.create.line.desc')} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                <Input label={i === 0 ? t('finance.create.line.qty') : undefined} aria-label={t('finance.create.line.qty')} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} inputMode="numeric" />
                <Input label={i === 0 ? t('finance.create.line.price') : undefined} aria-label={t('finance.create.line.price')} value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} inputMode="decimal" placeholder="0.00" />
                <Input label={i === 0 ? t('finance.create.line.discount') : undefined} aria-label={t('finance.create.line.discount')} value={l.discount} onChange={(e) => setLine(i, { discount: e.target.value })} inputMode="decimal" placeholder="0.00" />
                <Button type="button" variant="ghost" onClick={() => setLines((cur) => (cur.length > 1 ? cur.filter((_, x) => x !== i) : cur))} aria-label={t('finance.create.line.remove')}>✕</Button>
              </div>
            ))}
            <Button type="button" variant="secondary" onClick={() => setLines((cur) => [...cur, emptyLine()])}>{t('finance.create.addLine')}</Button>
            <div style={{ marginBlockStart: 16, textAlign: 'end', fontWeight: 600 }}>
              {t('finance.create.subtotal')}: {formatMoney(previewMinor, 'EGP', locale)}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBlockStart: 12 }}>
              <Button type="submit" loading={submitting}>{t('finance.create.submit')}</Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
