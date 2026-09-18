import { useState } from 'react';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, Table, EmptyState, ErrorState, Skeleton, type Column } from '../../../components/ui/index.js';
import { useToast } from '../../../components/ui/index.js';
import { PermissionGate } from '../../../components/auth/guards.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { formatDateTime } from '../../../lib/format/datetime.js';
import { ApiError } from '../../../lib/api/types.js';
import { listEvalRuns, runEval, type EvalRunRow } from '../api/ai.js';

/**
 * AI evaluation health. Shows the append-only eval ledger (numbers only, no PHI)
 * and lets an authorized operator run the deterministic suites on demand.
 */
export function AiHealthPage(): JSX.Element {
  const { t, locale } = useI18n();
  const toast = useToast();
  const runs = useQuery<EvalRunRow[]>((s) => listEvalRuns(s), []);
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    setBusy(true);
    try {
      await runEval();
      toast.notify(t('ai.health.ran'), 'success');
      runs.refetch();
    } catch (err) {
      toast.notify(err instanceof ApiError ? err.message : t('ai.err.load'), 'error');
    } finally {
      setBusy(false);
    }
  }

  const columns: Array<Column<EvalRunRow>> = [
    { key: 'suite', header: t('ai.health.col.suite'), render: (r) => r.suite },
    {
      key: 'result', header: t('ai.health.col.result'),
      render: (r) => <Badge tone={r.failed === 0 ? 'success' : 'danger'}>{r.passed}/{r.total}</Badge>,
    },
    { key: 'provider', header: t('ai.health.col.provider'), render: (r) => r.provider },
    { key: 'latency', header: t('ai.health.col.latency'), render: (r) => (r.avgLatencyMs != null ? Math.round(r.avgLatencyMs) : '—') },
    { key: 'at', header: t('ai.health.col.at'), render: (r) => formatDateTime(r.createdAt, locale) },
  ];

  return (
    <div>
      <PageHeader
        title={t('ai.health.title')}
        subtitle={t('ai.health.subtitle')}
        actions={<PermissionGate permission="ai:eval-run"><Button onClick={run} loading={busy}>{t('ai.health.run')}</Button></PermissionGate>}
      />
      <Card>
        {runs.loading ? (
          <div aria-busy="true" aria-label={t('common.loading')} style={{ display: 'grid', gap: 8 }}>{[0, 1].map((i) => <Skeleton key={i} height={28} />)}</div>
        ) : runs.error ? (
          <ErrorState title={t('ai.err.load')} body={runs.error.message} onRetry={runs.refetch} retryLabel={t('common.retry')} />
        ) : (
          <Table columns={columns} rows={runs.data ?? []} rowKey={(r) => r.id} empty={<EmptyState title={t('ai.health.empty.title')} body={t('ai.health.empty.body')} />} />
        )}
      </Card>
    </div>
  );
}
