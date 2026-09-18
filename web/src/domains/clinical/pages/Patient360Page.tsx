import { useParams, Link } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Card, Badge, Alert, EmptyState, ErrorState, Skeleton, type BadgeTone } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { formatDate, formatDateTime } from '../../../lib/format/datetime.js';
import { getPatient360, type Patient360, type PatientStatus } from '../api/clinical.js';

const STATUS_TONE: Record<PatientStatus, BadgeTone> = {
  active: 'success',
  inactive: 'neutral',
  deceased: 'neutral',
  merged: 'warning',
};

/** A present 360 section: a titled card listing compact item summaries. When the
 * caller may see the section but it holds nothing, the empty note is shown; a
 * section the caller cannot see is absent entirely (never rendered as empty). */
function Section({ title, items }: { title: string; items: string[] }): JSX.Element {
  const { t } = useI18n();
  return (
    <Card title={`${title} · ${t('clinical.p360.count', { n: items.length })}`}>
      {items.length === 0 ? (
        <span style={{ opacity: 0.7 }}>{t('clinical.p360.section.none')}</span>
      ) : (
        <ul style={{ margin: 0, paddingInlineStart: '1.1rem', display: 'grid', gap: 4 }}>
          {items.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function Patient360Page(): JSX.Element {
  const { t, locale } = useI18n();
  const { id = '' } = useParams();
  const query = useQuery<Patient360>((signal) => getPatient360(id, signal), [id]);

  if (query.loading) {
    return (
      <div>
        <PageHeader title={t('clinical.p360.title')} crumbs={[{ label: t('clinical.p360.back'), to: '/clinical/patients' }]} />
        <Card>
          <div aria-busy="true" aria-label={t('common.loading')} style={{ display: 'grid', gap: 8 }}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={28} />
            ))}
          </div>
        </Card>
      </div>
    );
  }

  if (query.error) {
    return (
      <div>
        <PageHeader title={t('clinical.p360.title')} crumbs={[{ label: t('clinical.p360.back'), to: '/clinical/patients' }]} />
        <ErrorState
          title={query.error.isForbidden ? t('clinical.forbidden') : t('clinical.err.load')}
          body={query.error.isForbidden ? undefined : query.error.message}
          onRetry={query.error.isForbidden ? undefined : query.refetch}
          retryLabel={t('common.retry')}
        />
      </div>
    );
  }

  const data = query.data;
  if (!data) return <EmptyState title={t('clinical.err.load')} />;
  const p = data.patient;

  // Build each PRESENT section into compact display lines. A section key that is
  // undefined means the caller lacks the read permission — we skip it entirely.
  const sections: Array<{ title: string; items: string[] }> = [];
  const push = <T,>(key: string, list: T[] | undefined, map: (x: T) => string): void => {
    if (list !== undefined) sections.push({ title: t(key), items: list.map(map) });
  };

  push('clinical.p360.section.allergies', data.allergies, (a) => `${a.substance} · ${a.severity} · ${a.status}`);
  push('clinical.p360.section.vitals', data.recentVitals, (v) => {
    const parts: string[] = [];
    if (v.heartRate != null) parts.push(`HR ${v.heartRate}`);
    if (v.systolicBp != null && v.diastolicBp != null) parts.push(`BP ${v.systolicBp}/${v.diastolicBp}`);
    if (v.spo2 != null) parts.push(`SpO₂ ${v.spo2}%`);
    if (v.temperatureC != null) parts.push(`${v.temperatureC}°C`);
    return `${formatDateTime(v.recordedAt, locale)} · ${parts.join(' · ') || '—'}`;
  });
  push('clinical.p360.section.prescriptions', data.activePrescriptions, (rx) => {
    const meds = (rx.items ?? []).map((it) => it.medicationName).filter(Boolean);
    return `${meds.join(', ') || rx.status} · ${rx.status}`;
  });
  push('clinical.p360.section.appointments', data.upcomingAppointments, (ap) =>
    `${formatDateTime(ap.startsAt, locale)} · ${ap.appointmentTypeName ?? ''} · ${ap.status}`.replace(' ·  · ', ' · '),
  );
  push('clinical.p360.section.visits', data.recentVisits, (v) =>
    `${v.visitDate ? formatDate(v.visitDate, locale) + ' · ' : ''}${v.primaryDiagnosis ?? '—'}`,
  );
  push('clinical.p360.section.referrals', data.referrals, (r) =>
    `${r.specialty ?? ''}${r.specialty ? ' · ' : ''}${r.status}`,
  );
  push('clinical.p360.section.followups', data.openFollowUps, (f) =>
    `${f.dueOn ? formatDate(f.dueOn, locale) + ' · ' : ''}${f.status}`,
  );
  push('clinical.p360.section.procedures', data.procedures, (pr) => `${pr.name} · ${pr.status}`);
  push('clinical.p360.section.careplans', data.carePlans, (c) => `${c.title} · ${c.status}`);
  push('clinical.p360.section.episodes', data.treatmentEpisodes, (e) => `${e.label} · ${e.status}`);

  return (
    <div>
      <PageHeader
        title={p.fullName}
        subtitle={`${t('clinical.patients.col.mrn')} ${p.mrn}`}
        crumbs={[{ label: t('clinical.p360.back'), to: '/clinical/patients' }]}
        actions={<Badge tone={STATUS_TONE[p.status]}>{t(`clinical.status.${p.status}`)}</Badge>}
      />

      {p.status === 'merged' && p.mergedIntoId && (
        <Alert tone="warning" role="alert">
          {t('clinical.patient.mergedNotice')}{' '}
          <Link to={`/clinical/patients/${p.mergedIntoId}`}>{t('clinical.patients.view')}</Link>
        </Alert>
      )}

      <Card title={t('clinical.p360.title')}>
        <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, margin: 0 }}>
          <div>
            <dt>{t('clinical.patients.col.sex')}</dt>
            <dd>{t(`clinical.sex.${p.sex}`)}</dd>
          </div>
          <div>
            <dt>{t('clinical.patients.col.dob')}</dt>
            <dd>{p.birthDate ? formatDate(p.birthDate, locale) : '—'}</dd>
          </div>
          <div>
            <dt>{t('clinical.patients.col.phone')}</dt>
            <dd>{p.phone ?? '—'}</dd>
          </div>
        </dl>
      </Card>

      {sections.length === 0 ? (
        <EmptyState title={t('clinical.p360.noSections')} />
      ) : (
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', marginBlockStart: 16 }}>
          {sections.map((s) => (
            <Section key={s.title} title={s.title} items={s.items} />
          ))}
        </div>
      )}
    </div>
  );
}
