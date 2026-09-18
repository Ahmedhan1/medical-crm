import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, Alert, Table, Tabs, EmptyState, ErrorState, Skeleton, type Column, type BadgeTone } from '../../../components/ui/index.js';
import { useToast } from '../../../components/ui/index.js';
import { PermissionGate } from '../../../components/auth/guards.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { formatDateTime } from '../../../lib/format/datetime.js';
import { listDrafts, type AIDraft, type DraftStatus } from '../api/ai.js';
import { IntakeDialog, SummaryDialog } from '../components/GenerateDialogs.js';

const STATUS_TONE: Record<DraftStatus, BadgeTone> = { pending: 'warning', confirmed: 'success', rejected: 'neutral' };

/**
 * AI drafts review workspace: intake and summary drafts with their human-review
 * state. Clinicians review here; confirming records a review but does not write
 * to the clinical record. Generation affordances are RBAC-gated.
 */
export function AiDraftsPage(): JSX.Element {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const [filter, setFilter] = useState<DraftStatus | 'all'>('all');
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const query = useQuery<AIDraft[]>((s) => listDrafts(filter === 'all' ? {} : { status: filter }, s), [filter]);

  const columns: Array<Column<AIDraft>> = [
    { key: 'kind', header: t('ai.drafts.col.kind'), render: (d) => t(`ai.kind.${d.kind}`) },
    { key: 'subject', header: t('ai.drafts.col.subject'), render: (d) => `${d.subjectType}` },
    { key: 'status', header: t('ai.drafts.col.status'), render: (d) => <Badge tone={STATUS_TONE[d.status]}>{t(`ai.status.${d.status}`)}</Badge> },
    { key: 'provider', header: t('ai.drafts.col.provider'), render: (d) => d.provider },
    { key: 'created', header: t('ai.drafts.col.created'), render: (d) => formatDateTime(d.createdAt, locale) },
    { key: 'ops', header: '', render: (d) => <Button variant="ghost" onClick={() => navigate(`/ai/drafts/${d.id}`)}>{t('ai.drafts.open')}</Button> },
  ];

  return (
    <div>
      <PageHeader
        title={t('ai.drafts.title')}
        subtitle={t('ai.drafts.subtitle')}
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <PermissionGate permission="ai:draft-create"><Button variant="secondary" onClick={() => setIntakeOpen(true)}>{t('ai.drafts.newIntake')}</Button></PermissionGate>
            <PermissionGate permission="ai:summary-generate"><Button variant="secondary" onClick={() => setSummaryOpen(true)}>{t('ai.drafts.newSummary')}</Button></PermissionGate>
          </div>
        }
      />
      <Alert tone="info">{t('ai.reviewFirst')}</Alert>

      <Card>
        <Tabs
          items={[
            { id: 'all', label: t('ai.drafts.filter.all') },
            { id: 'pending', label: t('ai.drafts.filter.pending') },
            { id: 'confirmed', label: t('ai.drafts.filter.confirmed') },
            { id: 'rejected', label: t('ai.drafts.filter.rejected') },
          ]}
          active={filter}
          onChange={(id) => setFilter(id as DraftStatus | 'all')}
        />
        <div style={{ marginBlockStart: 12 }}>
          {query.loading ? (
            <div aria-busy="true" aria-label={t('common.loading')} style={{ display: 'grid', gap: 8 }}>{[0, 1, 2].map((i) => <Skeleton key={i} height={28} />)}</div>
          ) : query.error ? (
            <ErrorState title={t('ai.err.load')} body={query.error.message} onRetry={query.refetch} retryLabel={t('common.retry')} />
          ) : (
            <Table columns={columns} rows={query.data ?? []} rowKey={(d) => d.id} empty={<EmptyState title={t('ai.drafts.empty.title')} body={t('ai.drafts.empty.body')} />} />
          )}
        </div>
      </Card>

      <IntakeDialog open={intakeOpen} onClose={() => setIntakeOpen(false)} onCreated={(d) => { setIntakeOpen(false); toast.notify(t('ai.gen.success'), 'success'); navigate(`/ai/drafts/${d.id}`); }} />
      <SummaryDialog open={summaryOpen} onClose={() => setSummaryOpen(false)} onCreated={(d) => { setSummaryOpen(false); toast.notify(t('ai.gen.success'), 'success'); navigate(`/ai/drafts/${d.id}`); }} />
    </div>
  );
}
