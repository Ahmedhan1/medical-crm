import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import {
  Button,
  Badge,
  Card,
  Table,
  EmptyState,
  ErrorState,
  Skeleton,
  type Column,
  type BadgeTone,
} from '../../../components/ui/index.js';
import { Input } from '../../../components/ui/fields.js';
import { useToast } from '../../../components/ui/index.js';
import { PermissionGate } from '../../../components/auth/guards.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { formatDate } from '../../../lib/format/datetime.js';
import { ApiError } from '../../../lib/api/types.js';
import {
  searchPatients,
  checkInPatient,
  type PatientSummary,
  type PatientStatus,
} from '../api/clinical.js';
import { RegisterPatientDialog } from '../components/RegisterPatientDialog.js';

const STATUS_TONE: Record<PatientStatus, BadgeTone> = {
  active: 'success',
  inactive: 'neutral',
  deceased: 'neutral',
  merged: 'warning',
};

/**
 * Patients workspace: search the roster and register new patients. Search only
 * fires for a term of 2+ characters (the backend minimum) and on submit, so a
 * patient name is not sent on every keystroke.
 */
export function PatientsPage(): JSX.Element {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const [input, setInput] = useState('');
  const [term, setTerm] = useState('');
  const [registerOpen, setRegisterOpen] = useState(false);
  const [checkingIn, setCheckingIn] = useState<string | null>(null);

  async function checkIn(patientId: string): Promise<void> {
    setCheckingIn(patientId);
    try {
      await checkInPatient(patientId);
      toast.notify(t('clinical.queue.checkIn.success'), 'success');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : t('clinical.err.load');
      toast.notify(message, 'error');
    } finally {
      setCheckingIn(null);
    }
  }

  const canSearch = term.trim().length >= 2;
  const query = useQuery<PatientSummary[]>(
    (signal) => (canSearch ? searchPatients(term.trim(), signal) : Promise.resolve([])),
    [term],
  );

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    setTerm(input);
  }

  const columns: Array<Column<PatientSummary>> = [
    { key: 'mrn', header: t('clinical.patients.col.mrn'), render: (p) => p.mrn },
    { key: 'name', header: t('clinical.patients.col.name'), render: (p) => p.fullName },
    { key: 'sex', header: t('clinical.patients.col.sex'), render: (p) => t(`clinical.sex.${p.sex}`) },
    {
      key: 'dob',
      header: t('clinical.patients.col.dob'),
      render: (p) => (p.birthDate ? formatDate(p.birthDate, locale) : '—'),
    },
    { key: 'phone', header: t('clinical.patients.col.phone'), render: (p) => p.phone ?? '—' },
    {
      key: 'status',
      header: t('clinical.patients.col.status'),
      render: (p) => <Badge tone={STATUS_TONE[p.status]}>{t(`clinical.status.${p.status}`)}</Badge>,
    },
    {
      key: 'actions',
      header: '',
      render: (p) => (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {p.status === 'active' && (
            <PermissionGate permission="encounter:checkin">
              <Button
                variant="secondary"
                loading={checkingIn === p.id}
                onClick={() => checkIn(p.id)}
              >
                {t('clinical.queue.checkIn')}
              </Button>
            </PermissionGate>
          )}
          <Button variant="ghost" onClick={() => navigate(`/clinical/patients/${p.id}`)}>
            {t('clinical.patients.view')}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t('clinical.patients.title')}
        subtitle={t('clinical.patients.subtitle')}
        actions={
          <PermissionGate permission="patient:register">
            <Button onClick={() => setRegisterOpen(true)}>{t('clinical.patients.register')}</Button>
          </PermissionGate>
        }
      />

      <Card>
        <form onSubmit={onSubmit} role="search" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <Input
              label={t('common.search')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('clinical.patients.search.placeholder')}
              type="search"
              aria-label={t('common.search')}
            />
          </div>
          <Button type="submit" disabled={input.trim().length < 2}>
            {t('common.search')}
          </Button>
        </form>

        <div style={{ marginBlockStart: 16 }}>
          {!canSearch ? (
            <EmptyState title={t('clinical.patients.search.hint')} />
          ) : query.loading ? (
            <div aria-busy="true" aria-label={t('common.loading')} style={{ display: 'grid', gap: 8 }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} height={28} />
              ))}
            </div>
          ) : query.error ? (
            <ErrorState
              title={t('clinical.err.load')}
              body={query.error.message}
              onRetry={query.refetch}
              retryLabel={t('common.retry')}
            />
          ) : (
            <Table
              columns={columns}
              rows={query.data ?? []}
              rowKey={(p) => p.id}
              empty={
                <EmptyState
                  title={t('clinical.patients.empty.title')}
                  body={t('clinical.patients.empty.body')}
                />
              }
            />
          )}
        </div>
      </Card>

      <RegisterPatientDialog
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onRegistered={(p) => {
          setRegisterOpen(false);
          navigate(`/clinical/patients/${p.id}`);
        }}
      />
    </div>
  );
}
