import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, Alert, EmptyState, ErrorState, Skeleton, type BadgeTone } from '../../../components/ui/index.js';
import { useToast } from '../../../components/ui/index.js';
import { PermissionGate } from '../../../components/auth/guards.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { formatDateTime } from '../../../lib/format/datetime.js';
import { ApiError } from '../../../lib/api/types.js';
import { getDraft, confirmDraft, rejectDraft, type AIDraft, type DraftStatus } from '../api/ai.js';

const STATUS_TONE: Record<DraftStatus, BadgeTone> = { pending: 'warning', confirmed: 'success', rejected: 'neutral' };

/**
 * Draft review detail. Shows the validated structured content + evidence, the
 * human-review state, and confirm/reject actions. A prominent notice reiterates
 * that confirming does NOT write to the clinical record (CCR-001) — the safety
 * boundary is visible to the reviewer, not just enforced server-side.
 */
export function AiDraftDetailPage(): JSX.Element {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const { id = '' } = useParams();
  const draft = useQuery<AIDraft>((s) => getDraft(id, s), [id]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);

  async function act(kind: 'confirm' | 'reject'): Promise<void> {
    setBusy(kind);
    try {
      await (kind === 'confirm' ? confirmDraft(id, note || undefined) : rejectDraft(id, note || undefined));
      toast.notify(t(kind === 'confirm' ? 'ai.detail.confirmed' : 'ai.detail.rejected'), 'success');
      draft.refetch();
    } catch (err) {
      toast.notify(err instanceof ApiError ? err.message : t('ai.err.load'), 'error');
    } finally {
      setBusy(null);
    }
  }

  if (draft.loading) return <Skeleton height={220} />;
  if (draft.error || !draft.data) return <ErrorState title={t('ai.err.load')} body={draft.error?.message} onRetry={draft.refetch} retryLabel={t('common.retry')} />;
  const d = draft.data;

  return (
    <div>
      <PageHeader
        title={`${t('ai.detail.title')} — ${t(`ai.kind.${d.kind}`)}`}
        actions={<Button variant="ghost" onClick={() => navigate('/ai/drafts')}>{t('ai.detail.back')}</Button>}
      />
      <Alert tone="warning">{t('ai.reviewFirst')}</Alert>

      <Card title={t('ai.detail.validation')}>
        {/* A persisted draft passed the versioned structured-output validator. */}
        <Badge tone="success">{t('ai.detail.validation.valid')}</Badge>
        {' '}<span className="mc-muted">{d.provider}{d.model ? ` · ${d.model}` : ''}</span>
      </Card>

      <Card title={t('ai.detail.content')}>
        <pre className="mc-code" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(d.content, null, 2)}</pre>
      </Card>

      <Card title={t('ai.detail.evidence')}>
        {d.citations.length === 0 ? (
          <EmptyState title={t('ai.detail.noEvidence')} />
        ) : (
          <ul>{d.citations.map((c, i) => <li key={i}><Badge tone="info">{c.kind}</Badge> <code>{c.ref}</code></li>)}</ul>
        )}
      </Card>

      <Card title={t('ai.detail.reviewState')}>
        <p><Badge tone={STATUS_TONE[d.status]}>{t(`ai.status.${d.status}`)}</Badge></p>
        {d.reviewedAt && <p>{t('ai.detail.reviewedAt')}: {formatDateTime(d.reviewedAt, locale)}</p>}
        {d.reviewNote && <p className="mc-muted">“{d.reviewNote}”</p>}

        {d.status === 'pending' && (
          <PermissionGate permission="ai:draft-review">
            <label className="mc-field" style={{ marginBlockStart: 12 }}>
              <span className="mc-field__label">{t('ai.detail.note')}</span>
              <textarea className="mc-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} aria-label={t('ai.detail.note')} />
            </label>
            <div style={{ display: 'flex', gap: 8, marginBlockStart: 8 }}>
              <Button loading={busy === 'confirm'} onClick={() => act('confirm')}>{t('ai.detail.confirm')}</Button>
              <Button variant="secondary" loading={busy === 'reject'} onClick={() => act('reject')}>{t('ai.detail.reject')}</Button>
            </div>
          </PermissionGate>
        )}
      </Card>
    </div>
  );
}
