import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, Table, EmptyState, ErrorState, Skeleton, type Column } from '../../../components/ui/index.js';
import { useToast } from '../../../components/ui/index.js';
import { PermissionGate } from '../../../components/auth/guards.js';
import { useAuth } from '../../../lib/auth/AuthContext.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { ApiError } from '../../../lib/api/types.js';
import { listRules, setRuleEnabled, type AutomationRule } from '../api/automation.js';
import { NewRuleDialog } from '../components/NewRuleDialog.js';

/**
 * Automation rules workspace: list rules with their trigger, action count,
 * version and enabled state; create a rule; toggle enable/disable; open a rule
 * for its history, dead-letter view and dry-run. All actions are RBAC-gated in
 * the UI (the backend re-enforces).
 */
export function AutomationRulesPage(): JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [newOpen, setNewOpen] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const query = useQuery<AutomationRule[]>((signal) => listRules(signal), []);

  async function toggle(rule: AutomationRule): Promise<void> {
    setToggling(rule.id);
    try {
      await setRuleEnabled(rule.id, !rule.isEnabled);
      toast.notify(t(rule.isEnabled ? 'auto.rules.enabled.off' : 'auto.rules.enabled.on'), 'success');
      query.refetch();
    } catch (err) {
      toast.notify(err instanceof ApiError ? err.message : t('auto.err.load'), 'error');
    } finally {
      setToggling(null);
    }
  }

  const canManage = can('automation:manage');
  const columns: Array<Column<AutomationRule>> = [
    { key: 'name', header: t('auto.rules.col.name'), render: (r) => r.name },
    {
      key: 'trigger',
      header: t('auto.rules.col.trigger'),
      render: (r) => (r.triggerType === 'event' ? (r.eventType ?? 'event') : `cron: ${r.scheduleCron ?? '—'}`),
    },
    { key: 'actions', header: t('auto.rules.col.actions'), render: (r) => String(r.actions.length) },
    { key: 'version', header: t('auto.rules.col.version'), render: (r) => `v${r.version}` },
    {
      key: 'enabled',
      header: t('auto.rules.col.enabled'),
      render: (r) => <Badge tone={r.isEnabled ? 'success' : 'neutral'}>{t(r.isEnabled ? 'auto.rules.col.enabled' : 'auto.rules.disable')}</Badge>,
    },
    {
      key: 'ops',
      header: '',
      render: (r) => (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {canManage && (
            <Button variant="secondary" loading={toggling === r.id} onClick={() => toggle(r)}>
              {t(r.isEnabled ? 'auto.rules.disable' : 'auto.rules.enable')}
            </Button>
          )}
          <Button variant="ghost" onClick={() => navigate(`/automation/rules/${r.id}`)}>{t('auto.rules.open')}</Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t('auto.rules.title')}
        subtitle={t('auto.rules.subtitle')}
        actions={
          <PermissionGate permission="automation:manage">
            <Button onClick={() => setNewOpen(true)}>{t('auto.rules.new')}</Button>
          </PermissionGate>
        }
      />
      <Card>
        {query.loading ? (
          <div aria-busy="true" aria-label={t('common.loading')} style={{ display: 'grid', gap: 8 }}>
            {[0, 1, 2].map((i) => <Skeleton key={i} height={28} />)}
          </div>
        ) : query.error ? (
          <ErrorState title={t('auto.err.load')} body={query.error.message} onRetry={query.refetch} retryLabel={t('common.retry')} />
        ) : (
          <Table
            columns={columns}
            rows={query.data ?? []}
            rowKey={(r) => r.id}
            empty={<EmptyState title={t('auto.rules.empty.title')} body={t('auto.rules.empty.body')} />}
          />
        )}
      </Card>

      <NewRuleDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(rule) => {
          setNewOpen(false);
          toast.notify(t('auto.rules.created'), 'success');
          navigate(`/automation/rules/${rule.id}`);
        }}
      />
    </div>
  );
}
