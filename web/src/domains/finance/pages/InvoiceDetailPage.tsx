import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import {
  Card, Badge, Button, Table, EmptyState, ErrorState, Skeleton, Alert, useToast,
  type Column, type BadgeTone,
} from '../../../components/ui/index.js';
import { PermissionGate } from '../../../components/auth/guards.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { formatDateTime } from '../../../lib/format/datetime.js';
import { ApiError } from '../../../lib/api/types.js';
import {
  getInvoice, issueInvoice, cancelInvoice, voidInvoice, reversePayment,
  type InvoiceDetail, type InvoiceItem, type Payment, type InvoiceStatus,
} from '../api/finance.js';
import { formatMoney } from '../format.js';
import { RecordPaymentDialog } from '../components/RecordPaymentDialog.js';

const STATUS_TONE: Record<InvoiceStatus, BadgeTone> = {
  draft: 'neutral', issued: 'info', partially_paid: 'warning', paid: 'success', void: 'danger', cancelled: 'neutral',
};

export function InvoiceDetailPage(): JSX.Element {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { id = '' } = useParams();
  const query = useQuery<InvoiceDetail>((signal) => getInvoice(id, signal), [id]);
  const [payOpen, setPayOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const inv = query.data;

  async function act(fn: () => Promise<unknown>, successKey: string): Promise<void> {
    setBusy(true);
    try {
      await fn();
      toast.notify(t(successKey), 'success');
      query.refetch();
    } catch (err) {
      toast.notify(err instanceof ApiError ? err.message : t('finance.err.load'), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (query.loading) {
    return (
      <div>
        <PageHeader title={t('finance.detail.title')} crumbs={[{ label: t('finance.nav.invoices'), to: '/finance/invoices' }]} />
        <Card><div style={{ display: 'grid', gap: 8 }}>{[0, 1, 2].map((i) => <Skeleton key={i} height={28} />)}</div></Card>
      </div>
    );
  }
  if (query.error || !inv) {
    return (
      <div>
        <PageHeader title={t('finance.detail.title')} crumbs={[{ label: t('finance.nav.invoices'), to: '/finance/invoices' }]} />
        <ErrorState
          title={query.error?.isForbidden ? t('finance.forbidden') : t('finance.err.load')}
          body={query.error && !query.error.isForbidden ? query.error.message : undefined}
          onRetry={query.error && !query.error.isForbidden ? query.refetch : undefined}
          retryLabel={t('common.retry')}
        />
      </div>
    );
  }

  const itemCols: Array<Column<InvoiceItem>> = [
    { key: 'desc', header: t('finance.create.line.desc'), render: (l) => l.description },
    { key: 'qty', header: t('finance.create.line.qty'), render: (l) => String(l.quantity) },
    { key: 'price', header: t('finance.create.line.price'), render: (l) => formatMoney(l.unitPriceMinor, inv.currency, locale) },
    { key: 'disc', header: t('finance.create.line.discount'), render: (l) => formatMoney(l.discountMinor, inv.currency, locale) },
    { key: 'tax', header: t('finance.create.tax'), render: (l) => formatMoney(l.taxMinor, inv.currency, locale) },
    { key: 'total', header: t('finance.create.total'), render: (l) => formatMoney(l.lineTotalMinor, inv.currency, locale) },
  ];
  const payCols: Array<Column<Payment>> = [
    { key: 'date', header: t('finance.inv.col.created'), render: (p) => formatDateTime(p.paidAt, locale) },
    { key: 'method', header: t('finance.pay.method'), render: (p) => t(`finance.method.${p.method}`) },
    { key: 'amount', header: t('finance.pay.amount'), render: (p) => formatMoney(p.amountMinor, p.currency, locale) },
    { key: 'status', header: t('finance.inv.col.status'), render: (p) => <Badge tone={p.status === 'reversed' ? 'danger' : 'success'}>{p.status}</Badge> },
    {
      key: 'actions', header: '', render: (p) =>
        p.status === 'completed' ? (
          <PermissionGate permission="payment:reverse">
            <Button variant="ghost" disabled={busy} onClick={() => {
              const reason = window.prompt(t('finance.detail.reverse'));
              if (reason && reason.trim().length >= 3) void act(() => reversePayment(p.id, reason.trim()), 'finance.detail.reversed');
            }}>{t('finance.detail.reverse')}</Button>
          </PermissionGate>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title={inv.invoiceNumber ?? t('finance.status.draft')}
        crumbs={[{ label: t('finance.nav.invoices'), to: '/finance/invoices' }]}
        actions={<Badge tone={STATUS_TONE[inv.status]}>{t(`finance.status.${inv.status}`)}</Badge>}
      />

      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px,1fr))', gap: 12 }}>
          <div><div style={{ opacity: 0.7, fontSize: '0.85rem' }}>{t('finance.create.total')}</div><div style={{ fontWeight: 600 }}>{formatMoney(inv.totalMinor, inv.currency, locale)}</div></div>
          <div><div style={{ opacity: 0.7, fontSize: '0.85rem' }}>{t('finance.inv.col.balance')}</div><div style={{ fontWeight: 600 }}>{formatMoney(inv.balanceDueMinor, inv.currency, locale)}</div></div>
          <div><div style={{ opacity: 0.7, fontSize: '0.85rem' }}>{t('finance.create.tax')}</div><div>{formatMoney(inv.taxMinor, inv.currency, locale)}</div></div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBlockStart: 16 }}>
          {inv.status === 'draft' && (
            <PermissionGate permission="invoice:issue">
              <Button disabled={busy} onClick={() => void act(() => issueInvoice(inv.id), 'finance.detail.issued')}>{t('finance.detail.issue')}</Button>
            </PermissionGate>
          )}
          {inv.status === 'draft' && (
            <PermissionGate permission="invoice:create">
              <Button variant="secondary" disabled={busy} onClick={() => void act(() => cancelInvoice(inv.id), 'finance.detail.cancelled')}>{t('finance.detail.cancel')}</Button>
            </PermissionGate>
          )}
          {(inv.status === 'issued' || inv.status === 'partially_paid') && (
            <PermissionGate permission="payment:record">
              <Button disabled={busy} onClick={() => setPayOpen(true)}>{t('finance.detail.recordPayment')}</Button>
            </PermissionGate>
          )}
          {(inv.status === 'issued' || inv.status === 'partially_paid') && inv.amountPaidMinor === 0 && (
            <PermissionGate permission="invoice:void">
              <Button variant="danger" disabled={busy} onClick={() => {
                const reason = window.prompt(t('finance.detail.void.reason'));
                if (reason && reason.trim().length >= 3) void act(() => voidInvoice(inv.id, reason.trim()), 'finance.detail.voided');
              }}>{t('finance.detail.void')}</Button>
            </PermissionGate>
          )}
        </div>
        {inv.voidReason && inv.status === 'void' && (
          <Alert tone="warning" role="status">{inv.voidReason}</Alert>
        )}
      </Card>

      <div style={{ marginBlockStart: 16 }}>
        <Card title={t('finance.detail.items')}>
          <Table columns={itemCols} rows={inv.items} rowKey={(l) => l.id} />
        </Card>
      </div>

      <div style={{ marginBlockStart: 16 }}>
        <Card title={t('finance.detail.payments')}>
          <Table
            columns={payCols}
            rows={inv.payments}
            rowKey={(p) => p.id}
            empty={<EmptyState title={t('finance.detail.noPayments')} />}
          />
        </Card>
      </div>

      <RecordPaymentDialog
        open={payOpen}
        onClose={() => setPayOpen(false)}
        invoiceId={inv.id}
        balanceDueMinor={inv.balanceDueMinor}
        currency={inv.currency}
        onRecorded={() => { setPayOpen(false); query.refetch(); }}
      />
    </div>
  );
}
