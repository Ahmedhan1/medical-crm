import { useState } from 'react';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, Alert, Table, EmptyState, ErrorState, Skeleton, type Column, type BadgeTone } from '../../../components/ui/index.js';
import { useToast } from '../../../components/ui/index.js';
import { PermissionGate } from '../../../components/auth/guards.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { formatDateTime } from '../../../lib/format/datetime.js';
import { ApiError } from '../../../lib/api/types.js';
import { listMessages, retryMessage, listPolicies, type MessageRecord, type MessageStatus, type MessagingPolicy } from '../api/automation.js';

const STATUS_TONE: Record<MessageStatus, BadgeTone> = {
  queued: 'info', sent: 'info', delivered: 'success', failed: 'warning', suppressed: 'neutral', dead: 'danger',
};

/**
 * Message delivery log: statuses, attempts, and retry of failed messages (which
 * re-checks consent + quiet hours + caps at delivery time on the backend). Shows
 * the clinic's communication guardrails so an operator understands why a message
 * may be suppressed or deferred. No message body or full recipient is ever shown
 * (the backend only stores a masked recipient).
 */
export function MessagingDeliveryPage(): JSX.Element {
  const { t, locale } = useI18n();
  const toast = useToast();
  const messages = useQuery<MessageRecord[]>((s) => listMessages(s), []);
  const policies = useQuery<MessagingPolicy[]>((s) => listPolicies(s), []);
  const [retrying, setRetrying] = useState<string | null>(null);

  async function retry(id: string): Promise<void> {
    setRetrying(id);
    try {
      await retryMessage(id);
      toast.notify(t('auto.delivery.retried'), 'success');
      messages.refetch();
    } catch (err) {
      toast.notify(err instanceof ApiError ? err.message : t('auto.err.load'), 'error');
    } finally {
      setRetrying(null);
    }
  }

  const columns: Array<Column<MessageRecord>> = [
    { key: 'created', header: t('auto.delivery.col.created'), render: (m) => formatDateTime(m.createdAt, locale) },
    { key: 'channel', header: t('auto.delivery.col.channel'), render: (m) => m.channel },
    { key: 'recipient', header: t('auto.delivery.col.recipient'), render: (m) => m.recipientMasked ?? '—' },
    {
      key: 'status', header: t('auto.delivery.col.status'),
      render: (m) => <Badge tone={STATUS_TONE[m.status]}>{m.status}{m.suppressedReason ? ` (${m.suppressedReason})` : ''}</Badge>,
    },
    { key: 'attempts', header: t('auto.delivery.col.attempts'), render: (m) => `${m.attempts}/${m.maxAttempts}` },
    {
      key: 'ops', header: '',
      render: (m) => (
        <PermissionGate permission="messaging:manage">
          {m.status === 'failed' && (
            <Button variant="secondary" loading={retrying === m.id} onClick={() => retry(m.id)}>{t('auto.delivery.retry')}</Button>
          )}
        </PermissionGate>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title={t('auto.delivery.title')} subtitle={t('auto.delivery.subtitle')} />

      <Card title={t('auto.delivery.policy.title')}>
        {policies.loading ? <Skeleton height={40} /> : (policies.data ?? []).length === 0 ? (
          <EmptyState title={t('auto.delivery.policy.none')} />
        ) : (
          <ul>
            {(policies.data ?? []).map((p) => (
              <li key={p.channel}>
                <strong>{p.channel}</strong> — {t('auto.delivery.policy.quiet')}:{' '}
                {p.quietHoursEnabled
                  ? t('auto.delivery.policy.quietOn').replace('{start}', String(p.quietStartHour)).replace('{end}', String(p.quietEndHour)).replace('{tz}', p.timeZone)
                  : t('auto.delivery.policy.quietOff')}
                {' · '}{t('auto.delivery.policy.cap')}: {p.dailyCap ?? '—'}
                {' · '}{t('auto.delivery.policy.gap')}: {p.minGapMinutes}
              </li>
            ))}
          </ul>
        )}
        <Alert tone="info">{t('auto.delivery.consentNote')}</Alert>
      </Card>

      <Card title={t('auto.delivery.title')}>
        {messages.loading ? (
          <div aria-busy="true" aria-label={t('common.loading')} style={{ display: 'grid', gap: 8 }}>
            {[0, 1, 2].map((i) => <Skeleton key={i} height={28} />)}
          </div>
        ) : messages.error ? (
          <ErrorState title={t('auto.err.load')} body={messages.error.message} onRetry={messages.refetch} retryLabel={t('common.retry')} />
        ) : (
          <Table columns={columns} rows={messages.data ?? []} rowKey={(m) => m.id} empty={<EmptyState title={t('auto.delivery.empty.title')} body={t('auto.delivery.empty.body')} />} />
        )}
      </Card>
    </div>
  );
}
