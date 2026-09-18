import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, Table, EmptyState, ErrorState, Skeleton, Input, type Column } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { listHcps, type Hcp } from '../api/crm.js';

const TONE: Record<Hcp['status'], 'success' | 'neutral' | 'warning'> = { active: 'success', inactive: 'neutral', retired: 'warning', merged: 'neutral' };

export function HcpListPage(): JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  const query = useQuery<Hcp[]>((s) => listHcps({ q: q || undefined }, s), [q]);

  const columns: Array<Column<Hcp>> = [
    { key: 'name', header: t('crm.hcps.col.name'), render: (h) => `${h.title ? `${h.title} ` : ''}${h.fullName}` },
    { key: 'cat', header: t('crm.hcps.col.category'), render: (h) => h.professionalCategory },
    { key: 'contact', header: t('crm.hcps.col.contact'), render: (h) => h.professionalEmail ?? h.professionalPhone ?? '—' },
    { key: 'status', header: t('crm.hcps.col.status'), render: (h) => <Badge tone={TONE[h.status]}>{t(`crm.status.${h.status}`)}</Badge> },
    { key: 'ops', header: '', render: (h) => <div style={{ textAlign: 'end' }}><Button variant="ghost" onClick={() => navigate(`/crm/hcps/${h.id}`)}>{t('crm.hcps.open')}</Button></div> },
  ];

  return (
    <div>
      <PageHeader title={t('crm.hcps.title')} subtitle={t('crm.hcps.subtitle')} />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); setQ(term.trim()); }} role="search" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBlockEnd: 12 }}>
          <div style={{ flex: 1 }}><Input label={t('crm.hcps.search')} value={term} onChange={(e) => setTerm(e.target.value)} aria-label={t('crm.hcps.search')} /></div>
          <Button type="submit" variant="secondary">{t('crm.hcps.search')}</Button>
        </form>
        {query.loading ? <Skeleton height={100} /> : query.error ? (
          <ErrorState title={t('crm.err.load')} body={query.error.message} onRetry={query.refetch} retryLabel={t('common.retry')} />
        ) : (
          <Table columns={columns} rows={query.data ?? []} rowKey={(h) => h.id} empty={<EmptyState title={t('crm.hcps.empty.title')} body={t('crm.hcps.empty.body')} />} />
        )}
      </Card>
    </div>
  );
}
