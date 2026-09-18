import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, Table, EmptyState, ErrorState, Skeleton, Input, type Column } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { listMedications, type Medication } from '../api/pharma.js';

const TONE = (v: string): 'success' | 'warning' | 'neutral' | 'danger' =>
  v === 'verified' ? 'success' : v === 'disputed' ? 'danger' : v === 'pending_review' ? 'warning' : 'neutral';

export function MedicationsPage(): JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  const query = useQuery<Medication[]>((s) => listMedications({ q: q || undefined }, s), [q]);

  const columns: Array<Column<Medication>> = [
    { key: 'generic', header: t('ph.meds.col.generic'), render: (m) => m.genericName },
    { key: 'atc', header: t('ph.meds.col.atc'), render: (m) => m.atcCode ?? '—' },
    { key: 'area', header: t('ph.meds.col.area'), render: (m) => m.therapeuticArea ?? '—' },
    { key: 'v', header: t('ph.meds.col.verification'), render: (m) => <Badge tone={TONE(m.verificationStatus)}>{m.verificationStatus}</Badge> },
    { key: 'ops', header: '', render: (m) => <div style={{ textAlign: 'end' }}><Button variant="ghost" onClick={() => navigate(`/pharma/medications/${m.id}`)}>{t('ph.meds.open')}</Button></div> },
  ];

  return (
    <div>
      <PageHeader title={t('ph.meds.title')} subtitle={t('ph.meds.subtitle')} />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); setQ(term.trim()); }} role="search" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBlockEnd: 12 }}>
          <div style={{ flex: 1 }}><Input label={t('ph.meds.search')} value={term} onChange={(e) => setTerm(e.target.value)} aria-label={t('ph.meds.search')} /></div>
          <Button type="submit" variant="secondary">{t('ph.meds.search')}</Button>
        </form>
        {query.loading ? <Skeleton height={100} /> : query.error ? (
          <ErrorState title={t('ph.err.load')} body={query.error.message} onRetry={query.refetch} retryLabel={t('common.retry')} />
        ) : (
          <Table columns={columns} rows={query.data ?? []} rowKey={(m) => m.id} empty={<EmptyState title={t('ph.meds.empty.title')} body={t('ph.meds.empty.body')} />} />
        )}
      </Card>
    </div>
  );
}
