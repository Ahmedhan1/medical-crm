import { withTransaction } from '../../db/pool.js';
import { audit } from '../governance/audit.js';
import type { ActionResult, EventContext } from './automation.types.js';
import { getActionHandler, type ActionContext } from './actions.js';
import { claimDue, markDone, markRetryOrFail } from './scheduled.repo.js';

/**
 * Scheduler RUN side (program Phase 3). Executes DUE scheduled actions through
 * the same action registry as event rules. Claiming is atomic (FOR UPDATE SKIP
 * LOCKED in the repo), so concurrent workers never double-run an action;
 * failures retry with backoff and dead-letter at the attempt cap; expired
 * actions are dropped, not sent late.
 *
 * Intended to be called on an interval by a worker, or on demand (an admin
 * "run scheduled now", or tests).
 */
export interface RunScheduledSummary {
  claimed: number;
  executed: number;
  succeeded: number;
  failed: number;
  expired: number;
}

/** Exponential backoff for a scheduled-action retry, capped at one hour. */
function backoffMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 2 ** attempts * 30 * 1000);
}

export async function runDueActions(limit = 200): Promise<RunScheduledSummary> {
  // Claim in its own transaction; execute each outside the claim so a network
  // send never holds the row lock.
  const claimed = await withTransaction((client) => claimDue(client, Math.min(limit, 500)));

  const summary: RunScheduledSummary = {
    claimed: claimed.length,
    executed: 0,
    succeeded: 0,
    failed: 0,
    expired: 0,
  };

  for (const action of claimed) {
    if (action.status === 'expired') {
      summary.expired += 1;
      await audit({
        clinicId: action.clinicId,
        actorId: null,
        action: 'automation.scheduled.expired',
        outcome: 'success',
        targetType: 'scheduled_action',
        targetId: action.id,
        metadata: { actionType: action.actionType },
      });
      continue;
    }

    summary.executed += 1;
    const handler = getActionHandler(action.actionType);

    if (!handler) {
      await markRetryOrFail(action.id, action.attempts, action.maxAttempts, `unknown_action_type:${action.actionType}`, new Date(Date.now() + backoffMs(action.attempts)));
      summary.failed += 1;
      continue;
    }

    // Scheduled actions have no triggering event; build an event-less context.
    // A synthetic dedupe key keeps downstream idempotency stable across retries.
    const ctx: ActionContext = {
      clinicId: action.clinicId,
      event: undefined,
      ruleId: action.ruleId ?? 'scheduled',
      runId: action.id,
      dedupeKey: `sched:${action.id}`,
      actionIndex: 0,
    };

    let result: ActionResult;
    try {
      result = await handler.execute(action.params, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'action error';
      const outcome = await markRetryOrFail(
        action.id,
        action.attempts,
        action.maxAttempts,
        message,
        new Date(Date.now() + backoffMs(action.attempts)),
      );
      summary.failed += 1;
      await audit({
        clinicId: action.clinicId,
        actorId: null,
        action: 'automation.scheduled.run',
        outcome: 'error',
        targetType: 'scheduled_action',
        targetId: action.id,
        metadata: { actionType: action.actionType, outcome, attempts: action.attempts },
      });
      continue;
    }

    if (result.status === 'error') {
      const outcome = await markRetryOrFail(
        action.id,
        action.attempts,
        action.maxAttempts,
        result.error ?? 'action reported error',
        new Date(Date.now() + backoffMs(action.attempts)),
      );
      summary.failed += 1;
      await audit({
        clinicId: action.clinicId,
        actorId: null,
        action: 'automation.scheduled.run',
        outcome: 'error',
        targetType: 'scheduled_action',
        targetId: action.id,
        metadata: { actionType: action.actionType, outcome },
      });
      continue;
    }

    await markDone(action.id, { type: result.type, status: result.status, detail: result.detail ?? {} });
    summary.succeeded += 1;
    await audit({
      clinicId: action.clinicId,
      actorId: null,
      action: 'automation.scheduled.run',
      outcome: 'success',
      targetType: 'scheduled_action',
      targetId: action.id,
      metadata: { actionType: action.actionType, resultStatus: result.status },
    });
  }

  return summary;
}
