import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import {
  Button, Badge, Card, Table, EmptyState, ErrorState, Skeleton,
  Pagination, type Column, type BadgeTone,
} from '../../../components/ui/index.js';
import { Select } from '../../../components/ui/fields.js';
import { PermissionGate } from '../../../components/auth/guards.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { formatDate } from '../../../lib/format/datetime.js';
import { listInvoices, type Invoice, type InvoiceStatus, type ListInvoicesResult } from '../api/finance.js';
import { formatMoney } from '../format.js';

const STATUS_TONE: Record<InvoiceStatus, BadgeTone> = {
  draft: 'neutral',
  issued: 'info',
  partially_paid: 'warning',
  paid: 'success',
  void: 'danger',
  cancelled: 'neutral',
};
const STATUSES: InvoiceStatus[] = ['draft', 'issued', 'partially_paid', 'paid', 'void', 'cancelled'];
const PAGE_SIZE = 20;

export function InvoiceListPage(): JSX.Element {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const [page, setPage] = useState(1);

  const query = useQuery<ListInvoicesResult>(
    (signal) => listInvoices({ status: status || undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }, signal),
    [status, page],
  );

  const columns: Array<Column<Invoice>> = [
    { key: 'number', header: t('finance.inv.col.number'), render: (i) => i.invoiceNumber ?? '—' },
    { key: 'status', header: t('finance.inv.col.status'), render: (i) => <Badge tone={STATUS_TONE[i.status]}>{t(`finance.status.${i.status}`)}</Badge> },
    { key: 'total', header: t('finance.inv.col.total'), render: (i) => formatMoney(i.totalMinor, i.currency, locale) },
    { key: 'balance', header: t('finance.inv.col.balance'), render: (i) => formatMoney(i.balanceDueMinor, i.currency, locale) },
    { key: 'created', header: t('finance.inv.col.created'), render: (i) => formatDate(i.createdAt, locale) },
    { key: 'actions', header: '', render: (i) => <Button variant="ghost" onClick={() => navigate(`/finance/invoices/${i.id}`)}>{t('finance.inv.view')}</Button> },
  ];

  const pageCount = query.data ? Math.max(1, Math.ceil(query.data.total / PAGE_SIZE)) : 1;

  return (
    <div>
      <PageHeader
        title={t('finance.inv.title')}
        actions={
          <PermissionGate permission="invoice:create">
            <Button onClick={() => navigate('/finance/invoices/new')}>{t('finance.inv.new')}</Button>
          </PermissionGate>
        }
      />
      <Card>
        <div style={{ marginBlockEnd: 12, maxWidth: 260 }}>
          <Select
            aria-label={t('finance.inv.col.status')}
            value={status}
            onChange={(e) => { setPage(1); setStatus(e.target.value as InvoiceStatus | ''); }}
          >
            <option value="">{t('finance.inv.filter.all')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t(`finance.status.${s}`)}</option>)}
          </Select>
        </div>
        {query.loading ? (
          <div style={{ display: 'grid', gap: 8 }}>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={28} />)}</div>
        ) : query.error ? (
          <ErrorState
            title={query.error.isForbidden ? t('finance.forbidden') : t('finance.err.load')}
            body={query.error.isForbidden ? undefined : query.error.message}
            onRetry={query.error.isForbidden ? undefined : query.refetch}
            retryLabel={t('common.retry')}
          />
        ) : (
          <>
            <Table
              columns={columns}
              rows={query.data?.invoices ?? []}
              rowKey={(i) => i.id}
              empty={<EmptyState title={t('finance.inv.empty.title')} body={t('finance.inv.empty.body')} />}
            />
            {query.data && query.data.total > PAGE_SIZE && (
              <div style={{ marginBlockStart: 12 }}>
                <Pagination
                  page={page}
                  pageCount={pageCount}
                  onChange={setPage}
                  labels={{ previous: t('common.previous'), next: t('common.next'), page: t('common.page'), of: t('common.of') }}
                />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
