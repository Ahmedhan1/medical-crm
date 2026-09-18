import { useState, type FormEvent } from 'react';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, Table, EmptyState, ErrorState, Skeleton, Alert, Dialog, Input, Select, type Column } from '../../../components/ui/index.js';
import { useToast } from '../../../components/ui/index.js';
import { PermissionGate } from '../../../components/auth/guards.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { ApiError } from '../../../lib/api/types.js';
import { createLocation, listLocations, type InventoryLocation, type LocationKind } from '../api/inventory.js';

const KINDS: LocationKind[] = ['store', 'dispensary', 'room', 'cold_chain', 'other'];

export function InventoryLocationsPage(): JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const query = useQuery<InventoryLocation[]>((s) => listLocations(s), []);

  const columns: Array<Column<InventoryLocation>> = [
    { key: 'code', header: t('inv.locations.col.code'), render: (l) => l.code },
    { key: 'name', header: t('inv.locations.col.name'), render: (l) => l.name },
    { key: 'kind', header: t('inv.locations.col.kind'), render: (l) => t(`inv.kind.${l.kind}`) },
    { key: 'status', header: t('inv.locations.col.status'), render: (l) => <Badge tone={l.isActive ? 'success' : 'neutral'}>{t(l.isActive ? 'inv.products.active' : 'inv.products.inactive')}</Badge> },
  ];

  return (
    <div>
      <PageHeader
        title={t('inv.locations.title')}
        subtitle={t('inv.locations.subtitle')}
        actions={<PermissionGate permission="inventory:manage"><Button onClick={() => setOpen(true)}>{t('inv.locations.new')}</Button></PermissionGate>}
      />
      <Card>
        {query.loading ? <Skeleton height={80} /> : query.error ? (
          <ErrorState title={t('inv.err.load')} body={query.error.message} onRetry={query.refetch} retryLabel={t('common.retry')} />
        ) : (
          <Table columns={columns} rows={query.data ?? []} rowKey={(l) => l.id} empty={<EmptyState title={t('inv.locations.empty.title')} body={t('inv.locations.empty.body')} />} />
        )}
      </Card>
      <NewLocationDialog open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); toast.notify(t('inv.locations.created'), 'success'); query.refetch(); }} />
    </div>
  );
}

function NewLocationDialog(props: { open: boolean; onClose: () => void; onDone: () => void }): JSX.Element {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<LocationKind>('store');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!code.trim() || !name.trim()) { setError(t('inv.form.err.name')); return; }
    setBusy(true);
    try {
      await createLocation({ code: code.trim(), name: name.trim(), kind });
      setCode(''); setName(''); setKind('store');
      props.onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('inv.err.load'));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={props.open} onClose={props.onClose} title={t('inv.locations.new')}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Input label={t('inv.locations.form.code')} value={code} onChange={(e) => setCode(e.target.value)} />
        <Input label={t('inv.locations.form.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <Select label={t('inv.locations.form.kind')} value={kind} onChange={(e) => setKind(e.target.value as LocationKind)}>
          {KINDS.map((k) => <option key={k} value={k}>{t(`inv.kind.${k}`)}</option>)}
        </Select>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={props.onClose}>{t('common.cancel')}</Button>
          <Button type="submit" loading={busy}>{t('inv.locations.new')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
