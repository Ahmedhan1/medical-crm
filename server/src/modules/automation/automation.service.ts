import { withTransaction } from '../../db/pool.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';
import { auditTx } from '../governance/audit.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { Permission } from '../governance/permissions.js';
import {
  CreateRuleSchema,
  UpdateRuleSchema,
  type AutomationRule,
  type AutomationRun,
  type CreateRuleInput,
  type UpdateRuleInput,
} from './automation.types.js';
import { validateActions } from './actions.js';
import * as repo from './automation.repo.js';
import { processNewEvents, type ProcessSummary } from './engine.js';
import { runDueActions, type RunScheduledSummary } from './scheduler.runner.js';
import { listScheduled, getScheduled, cancelScheduled } from './scheduled.repo.js';
import type { ScheduledAction } from './automation.types.js';
import { ConflictError } from '../../domain/errors.js';
import { audit } from '../governance/audit.js';

/**
 * Automation rule administration. Rule config is an administrative capability
 * (AUTOMATION_MANAGE); reading rules/runs needs AUTOMATION_READ. Every mutation
 * is audited and clinic-scoped.
 */

export async function createRule(principal: Principal, raw: unknown): Promise<AutomationRule> {
  requirePermission(principal, Permission.AUTOMATION_MANAGE);
  const parsed = CreateRuleSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid automation rule', parsed.error.flatten());
  const input: CreateRuleInput = parsed.data;

  // Reject a rule whose actions can never execute (unknown type / bad params).
  try {
    validateActions(input.actions);
  } catch (err) {
    throw new ValidationError('Invalid automation action', {
      message: err instanceof Error ? err.message : 'invalid action',
    });
  }

  return withTransaction(async (client) => {
    const rule = await repo.insertRule(client, principal.clinicId, principal.userId, input);
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'automation.rule.create',
      outcome: 'success',
      targetType: 'automation_rule',
      targetId: rule.id,
      metadata: { triggerType: rule.triggerType, eventType: rule.eventType, enabled: rule.isEnabled },
    });
    return rule;
  });
}

export async function listRules(principal: Principal): Promise<AutomationRule[]> {
  requirePermission(principal, Permission.AUTOMATION_READ);
  return repo.listRules(principal.clinicId);
}

export async function getRule(principal: Principal, id: string): Promise<AutomationRule> {
  requirePermission(principal, Permission.AUTOMATION_READ);
  const rule = await repo.getRuleById(principal.clinicId, id);
  if (!rule) throw new NotFoundError('Automation rule');
  return rule;
}

export async function updateRule(principal: Principal, id: string, raw: unknown): Promise<AutomationRule> {
  requirePermission(principal, Permission.AUTOMATION_MANAGE);
  const parsed = UpdateRuleSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid automation update', parsed.error.flatten());
  const patch: UpdateRuleInput = parsed.data;
  if (patch.actions) {
    try {
      validateActions(patch.actions);
    } catch (err) {
      throw new ValidationError('Invalid automation action', {
        message: err instanceof Error ? err.message : 'invalid action',
      });
    }
  }

  return withTransaction(async (client) => {
    const rule = await repo.updateRule(client, principal.clinicId, id, patch);
    if (!rule) throw new NotFoundError('Automation rule');
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'automation.rule.update',
      outcome: 'success',
      targetType: 'automation_rule',
      targetId: rule.id,
      metadata: { enabled: rule.isEnabled },
    });
    return rule;
  });
}

export async function deleteRule(principal: Principal, id: string): Promise<void> {
  requirePermission(principal, Permission.AUTOMATION_MANAGE);
  await withTransaction(async (client) => {
    const deleted = await repo.deleteRule(client, principal.clinicId, id);
    if (!deleted) throw new NotFoundError('Automation rule');
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'automation.rule.delete',
      outcome: 'success',
      targetType: 'automation_rule',
      targetId: id,
    });
  });
}

export async function listRuns(principal: Principal, ruleId: string): Promise<AutomationRun[]> {
  requirePermission(principal, Permission.AUTOMATION_READ);
  // Ensure the rule is in the caller's clinic before exposing its runs.
  const rule = await repo.getRuleById(principal.clinicId, ruleId);
  if (!rule) throw new NotFoundError('Automation rule');
  return repo.listRunsForRule(principal.clinicId, ruleId);
}

/**
 * Process new events now (drives the engine on demand). A scheduler would call
 * the underlying engine directly; the HTTP entry point is admin-gated.
 */
export async function processNow(principal: Principal): Promise<ProcessSummary> {
  requirePermission(principal, Permission.AUTOMATION_MANAGE);
  return processNewEvents();
}

/**
 * Run all DUE scheduled actions now (the time-engine tick). A worker would call
 * `runDueActions` directly on an interval; the HTTP entry point is admin-gated.
 */
export async function runScheduledNow(principal: Principal): Promise<RunScheduledSummary> {
  requirePermission(principal, Permission.AUTOMATION_MANAGE);
  return runDueActions();
}

export async function listScheduledActions(
  principal: Principal,
  status?: ScheduledAction['status'],
): Promise<ScheduledAction[]> {
  requirePermission(principal, Permission.AUTOMATION_READ);
  return listScheduled(principal.clinicId, status);
}

export async function cancelScheduledAction(principal: Principal, id: string): Promise<ScheduledAction> {
  requirePermission(principal, Permission.AUTOMATION_MANAGE);
  const outcome = await cancelScheduled(principal.clinicId, id);
  if (outcome === 'not_found') throw new NotFoundError('Scheduled action');
  if (outcome === 'not_pending') throw new ConflictError('Only a pending scheduled action can be cancelled');
  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'automation.scheduled.cancel',
    outcome: 'success',
    targetType: 'scheduled_action',
    targetId: id,
  });
  const action = await getScheduled(principal.clinicId, id);
  if (!action) throw new NotFoundError('Scheduled action');
  return action;
}
