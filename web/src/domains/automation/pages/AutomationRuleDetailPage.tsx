import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, Alert, Table, EmptyState, ErrorState, Skeleton, type Column, type BadgeTone } from '../../../components/ui/index.js';
import { Input } from '../../../components/ui/fields.js';
import { useToast } from '../../../components/ui/index.js';
import { PermissionGate } from '../../../components/auth/guards.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { formatDateTime } from '../../../lib/format/datetime.js';
import { ApiError } from '../../../lib/api/types.js';
import {
  getRule, listRuns, listScheduledActions, cancelScheduledAction, simulateRule,
  type AutomationRule, type AutomationRun, type ScheduledAction, type RuleSimulation, type RunStatus,
} from '../api/automation.js';

const RUN_TONE: Record<RunStatus, BadgeTone> = { succeeded: 'success', failed: 'danger', skipped: 'neutral', pending: 'info' };

/**
 * Rule detail: definition (trigger, schedule/delay, version, priority), conditions
 * and actions (read-only), execution history, failed/dead-letter scheduled actions
 * (with cancel), and an inline dry-run that sends/schedules nothing.
 */
export function AutomationRuleDetailPage(): JSX.Element {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const { id = '' } = useParams();
  const rule = useQuery<AutomationRule>((s) => getRule(id, s), [id]);
  const runs = useQuery<AutomationRun[]>((s) => listRuns(id, s), [id]);
  const dlq = useQuery<ScheduledAction[]>((s) => listScheduledActions('failed', s), [id]);

  const [simEvent, setSimEvent] = useState('');
  const [simPatient, setSimPatient] = useState('');
  const [sim, setSim] = useState<RuleSimulation | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);

  async function runSim(): Promise<void> {
    setSimBusy(true);
    setSim(null);
    try {
      const res = await simulateRule(id, {
        type: simEvent.trim() || (rule.data?.eventType ?? ''),
        ...(simPatient.trim() ? { payload: { patientId: simPatient.trim() } } : {}),
      });
      setSim(res);
    } catch (err) {
      toast.notify(err instanceof ApiError ? err.message : t('auto.err.load'), 'error');
    } finally {
      setSimBusy(false);
    }
  }

  async function cancel(actionId: string): Promise<void> {
    setCancelling(actionId);
    try {
      await cancelScheduledAction(actionId);
      toast.notify(t('auto.detail.dlq.cancelled'), 'success');
      dlq.refetch();
    } catch (err) {
      toast.notify(err instanceof ApiError ? err.message : t('auto.err.load'), 'error');
    } finally {
      setCancelling(null);
    }
  }

  if (rule.loading) return <div aria-busy="true" aria-label={t('common.loading')}><Skeleton height={200} /></div>;
  if (rule.error || !rule.data) {
    return <ErrorState title={t('auto.err.load')} body={rule.error?.message} onRetry={rule.refetch} retryLabel={t('common.retry')} />;
  }
  const r = rule.data;

  // Scheduled actions belonging to THIS rule (the backend filters by clinic; we
  // scope to this rule's failures for the dead-letter view).
  const ruleDlq = (dlq.data ?? []).filter((a) => a.ruleId === r.id);

  const runCols: Array<Column<AutomationRun>> = [
    { key: 'status', header: t('auto.detail.run.status'), render: (x) => <Badge tone={RUN_TONE[x.status]}>{x.status}</Badge> },
    { key: 'matched', header: t('auto.detail.run.matched'), render: (x) => (x.matched ? t('auto.sim.yes') : t('auto.sim.no')) },
    { key: 'started', header: t('auto.detail.run.started'), render: (x) => formatDateTime(x.startedAt, locale) },
    { key: 'error', header: t('auto.detail.run.error'), render: (x) => x.lastError ?? '—' },
  ];
  const dlqCols: Array<Column<ScheduledAction>> = [
    { key: 'action', header: t('auto.detail.dlq.col.action'), render: (x) => x.actionType },
    { key: 'attempts', header: t('auto.detail.dlq.col.attempts'), render: (x) => `${x.attempts}/${x.maxAttempts}` },
    { key: 'error', header: t('auto.detail.dlq.col.error'), render: (x) => x.lastError ?? '—' },
    {
      key: 'ops', header: '',
      render: (x) => (
        <PermissionGate permission="automation:manage">
          {x.status === 'pending' && (
            <Button variant="secondary" loading={cancelling === x.id} onClick={() => cancel(x.id)}>{t('auto.detail.dlq.cancel')}</Button>
          )}
        </PermissionGate>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={`${t('auto.detail.title')}: ${r.name}`}
        actions={<Button variant="ghost" onClick={() => navigate('/automation/rules')}>{t('auto.detail.back')}</Button>}
      />

      <Card title={t('auto.detail.section.definition')}>
        <dl className="mc-defs">
          <div><dt>{t('auto.detail.trigger')}</dt><dd>{r.triggerType === 'event' ? (r.eventType ?? 'event') : t('auto.detail.schedule')}</dd></div>
          {r.triggerType === 'schedule' && <div><dt>{t('auto.detail.schedule')}</dt><dd>{r.scheduleCron ?? '—'}</dd></div>}
          <div><dt>{t('auto.detail.version')}</dt><dd>v{r.version}</dd></div>
          <div><dt>{t('auto.detail.priority')}</dt><dd>{r.priority}</dd></div>
          <div><dt>{t('auto.rules.col.enabled')}</dt><dd><Badge tone={r.isEnabled ? 'success' : 'neutral'}>{r.isEnabled ? 'on' : 'off'}</Badge></dd></div>
        </dl>
      </Card>

      <Card title={t('auto.detail.section.conditions')}>
        {r.conditions.length === 0 ? (
          <EmptyState title={t('auto.detail.noConditions')} />
        ) : (
          <ul>{r.conditions.map((c, i) => <li key={i}><code>{c.field} {c.op} {JSON.stringify(c.value ?? null)}</code></li>)}</ul>
        )}
      </Card>

      <Card title={t('auto.detail.section.actions')}>
        <ul>{r.actions.map((a, i) => <li key={i}><Badge tone="info">{a.type}</Badge> <code>{JSON.stringify(a.params)}</code></li>)}</ul>
      </Card>

      <Card title={t('auto.sim.title')}>
        <p>{t('auto.sim.subtitle')}</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <Input label={t('auto.sim.eventType')} value={simEvent} onChange={(e) => setSimEvent(e.target.value)} placeholder={r.eventType ?? 'EVENT_TYPE'} />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <Input label={t('auto.sim.patientId')} value={simPatient} onChange={(e) => setSimPatient(e.target.value)} />
          </div>
          <Button onClick={runSim} loading={simBusy}>{t('auto.sim.run')}</Button>
        </div>
        {sim && (
          <div style={{ marginBlockStart: 12 }} aria-live="polite">
            <p>{t('auto.sim.triggerMatched')}: <Badge tone={sim.triggerMatched ? 'success' : 'neutral'}>{sim.triggerMatched ? t('auto.sim.yes') : t('auto.sim.no')}</Badge></p>
            <p>{t('auto.sim.conditionsPassed')}: <Badge tone={sim.conditionsPassed ? 'success' : 'neutral'}>{sim.conditionsPassed ? t('auto.sim.yes') : t('auto.sim.no')}</Badge></p>
            <ul>
              {sim.actions.map((a) => (
                <li key={a.index}>{a.type}: <Badge tone={a.wouldExecute ? 'success' : 'neutral'}>{a.wouldExecute ? t('auto.sim.yes') : t('auto.sim.no')}</Badge> <span className="mc-muted">({a.reason})</span></li>
              ))}
            </ul>
            <Alert tone="info">{t('auto.sim.noSideEffects')}</Alert>
          </div>
        )}
      </Card>

      <Card title={t('auto.detail.section.history')}>
        {runs.loading ? <Skeleton height={80} /> : runs.error ? (
          <ErrorState title={t('auto.err.load')} onRetry={runs.refetch} retryLabel={t('common.retry')} />
        ) : (
          <Table columns={runCols} rows={runs.data ?? []} rowKey={(x) => x.id} empty={<EmptyState title={t('auto.detail.history.empty')} />} />
        )}
      </Card>

      <Card title={t('auto.detail.section.deadletter')}>
        {dlq.loading ? <Skeleton height={60} /> : (
          <Table columns={dlqCols} rows={ruleDlq} rowKey={(x) => x.id} empty={<EmptyState title={t('auto.detail.dlq.empty')} />} />
        )}
      </Card>
    </div>
  );
}
