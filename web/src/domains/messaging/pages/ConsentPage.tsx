import { useState, type FormEvent } from 'react';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, Table, EmptyState, ErrorState, Skeleton, type Column, type BadgeTone } from '../../../components/ui/index.js';
import { Input } from '../../../components/ui/fields.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { formatDateTime } from '../../../lib/format/datetime.js';
import { getConsents, type ConsentRecord, type ConsentStatus } from '../api/messaging.js';

const TONE: Record<ConsentStatus, BadgeTone> = { opted_in: 'success', opted_out: 'danger', unknown: 'neutral' };

/**
 * Consent visibility: look up a patient's per-channel communication consent.
 * Read-only — recording consent stays in the clinical/reception flow. Reinforces
 * that consent is enforced at delivery, not just at scheduling.
 */
export function ConsentPage(): JSX.Element {
  const { t, locale } = useI18n();
  const [input, setInput] = useState('');
  const [patientId, setPatientId] = useState('');
  const query = useQuery<ConsentRecord[]>(
    (s) => (patientId ? getConsents(patientId, s) : Promise.resolve([])),
    [patientId],
  );

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    setPatientId(input.trim());
  }

  const columns: Array<Column<ConsentRecord>> = [
    { key: 'channel', header: t('msg.consent.col.channel'), render: (c) => c.channel },
    { key: 'status', header: t('msg.consent.col.status'), render: (c) => <Badge tone={TONE[c.status]}>{t(`msg.consent.status.${c.status}`)}</Badge> },
    { key: 'updated', header: t('msg.consent.col.updated'), render: (c) => formatDateTime(c.updatedAt, locale) },
  ];

  return (
    <div>
      <PageHeader title={t('msg.consent.title')} subtitle={t('msg.consent.subtitle')} />
      <Card>
        <form onSubmit={onSubmit} role="search" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <Input label={t('msg.consent.patientId')} value={input} onChange={(e) => setInput(e.target.value)} aria-label={t('msg.consent.patientId')} />
          </div>
          <Button type="submit" disabled={input.trim().length < 8}>{t('msg.consent.lookup')}</Button>
        </form>

        <div style={{ marginBlockStart: 16 }}>
          {!patientId ? null : query.loading ? (
            <Skeleton height={80} />
          ) : query.error ? (
            <ErrorState title={t('msg.err.load')} body={query.error.message} onRetry={query.refetch} retryLabel={t('common.retry')} />
          ) : (
            <Table columns={columns} rows={query.data ?? []} rowKey={(c) => c.channel} empty={<EmptyState title={t('msg.consent.empty')} />} />
          )}
        </div>
      </Card>
    </div>
  );
}
