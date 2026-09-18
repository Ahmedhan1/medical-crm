import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Card, EmptyState, ErrorState, Skeleton, Button } from '../../../components/ui/index.js';
import { PermissionGate } from '../../../components/auth/guards.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { getSummary, type FinancialSummary } from '../api/finance.js';
import { formatMoney } from '../format.js';

function Kpi({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Card>
      <div style={{ fontSize: '0.85rem', opacity: 0.7 }}>{label}</div>
      <div style={{ fontSize: '1.6rem', fontWeight: 600, marginBlockStart: 4 }}>{value}</div>
    </Card>
  );
}

export function BillingDashboardPage(): JSX.Element {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const query = useQuery<FinancialSummary>((signal) => getSummary({}, signal), []);

  return (
    <div>
      <PageHeader
        title={t('finance.dash.title')}
        subtitle={t('finance.dash.subtitle')}
        actions={
          <PermissionGate permission="invoice:create">
            <Button onClick={() => navigate('/finance/invoices/new')}>
              {t('finance.inv.new')}
            </Button>
          </PermissionGate>
        }
      />
      {query.loading ? (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={72} />)}
        </div>
      ) : query.error ? (
        <ErrorState
          title={query.error.isForbidden ? t('finance.forbidden') : t('finance.err.load')}
          body={query.error.isForbidden ? undefined : query.error.message}
          onRetry={query.error.isForbidden ? undefined : query.refetch}
          retryLabel={t('common.retry')}
        />
      ) : query.data ? (
        <>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))' }}>
            <Kpi label={t('finance.dash.revenue')} value={formatMoney(query.data.revenueMinor, query.data.currency, locale)} />
            <Kpi label={t('finance.dash.outstanding')} value={formatMoney(query.data.outstandingMinor, query.data.currency, locale)} />
            <Kpi label={t('finance.dash.paid')} value={String(query.data.paidInvoiceCount)} />
            <Kpi label={t('finance.dash.issued')} value={String(query.data.issuedInvoiceCount)} />
          </div>
          <div style={{ marginBlockStart: 16 }}>
            <Card title={t('finance.dash.byMethod')}>
              {query.data.byMethod.length === 0 ? (
                <EmptyState title={t('finance.dash.payments')} body="0" />
              ) : (
                <ul style={{ margin: 0, paddingInlineStart: '1.1rem', display: 'grid', gap: 4 }}>
                  {query.data.byMethod.map((m) => (
                    <li key={m.method}>
                      {t(`finance.method.${m.method}`)}: {formatMoney(m.amountMinor, query.data!.currency, locale)} ({m.count})
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          <div style={{ marginBlockStart: 16 }}>
            <Link to="/finance/invoices">{t('finance.nav.invoices')}</Link>
          </div>
        </>
      ) : null}
    </div>
  );
}
