import { useState } from 'react';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Card, Table, EmptyState, ErrorState, Skeleton, Input, type Column } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { listHcos, type Hco } from '../api/crm.js';

export function HcoListPage(): JSX.Element {
  const { t } = useI18n();
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  const query = useQuery<Hco[]>((s) => listHcos({ q: q || undefined }, s), [q]);

  const location = (h: Hco): string => [h.city, h.region, h.country].filter(Boolean).join(', ') || '—';
  const columns: Array<Column<Hco>> = [
    { key: 'name', header: t('crm.hcos.col.name'), render: (h) => h.name },
    { key: 'type', header: t('crm.hcos.col.type'), render: (h) => h.hcoType },
    { key: 'loc', header: t('crm.hcos.col.location'), render: location },
    { key: 'status', header: t('crm.hcos.col.status'), render: (h) => h.operatingStatus },
  ];

  return (
    <div>
      <PageHeader title={t('crm.hcos.title')} subtitle={t('crm.hcos.subtitle')} />
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); setQ(term.trim()); }} role="search" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBlockEnd: 12 }}>
          <div style={{ flex: 1 }}><Input label={t('crm.hcos.search')} value={term} onChange={(e) => setTerm(e.target.value)} aria-label={t('crm.hcos.search')} /></div>
          <Button type="submit" variant="secondary">{t('crm.hcos.search')}</Button>
        </form>
        {query.loading ? <Skeleton height={100} /> : query.error ? (
          <ErrorState title={t('crm.err.load')} body={query.error.message} onRetry={query.refetch} retryLabel={t('common.retry')} />
        ) : (
          <Table columns={columns} rows={query.data ?? []} rowKey={(h) => h.id} empty={<EmptyState title={t('crm.hcos.empty.title')} body={t('crm.hcos.empty.body')} />} />
        )}
      </Card>
    </div>
  );
}
