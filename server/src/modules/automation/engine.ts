import { getPool, withTransaction } from '../../db/pool.js';
import { audit } from '../governance/audit.js';
import type { ActionResult, AutomationRule, StoredEvent } from './automation.types.js';
import { toEventContext } from './automation.types.js';
import { evaluateConditions } from './conditions.js';
import { getActionHandler, type ActionContext } from './actions.js';
import { findEnabledEventRules, readEventsAfter } from './automation.repo.js';

/**
 * The automation executor.
 *
 * Idempotency is enforced at the database: a run row is claimed with
 * UNIQUE(rule_id, dedupe_key) BEFORE any action executes. If the insert
 * conflicts, this (rule, event) was already processed — the engine returns
 * `already_ran` and does nothing. This makes at-most-once execution safe under
 * re-processing and concurrent workers alike.
 */
export type RunOutcome =
  | { result: 'already_ran' }
  | { result: 'skipped'; runId: string }
  | { result: 'succeeded'; runId: string; actionResults: ActionResult[] }
  | { result: 'failed'; runId: string; actionResults: ActionResult[]; error: string };

const OFFSET_NAME = 'event';

export async function runRuleForEvent(rule: AutomationRule, event: StoredEvent): Promise<RunOutcome> {
  const dedupeKey = `evt:${event.id}`;

  // 1. Claim the run (idempotency guard). Conflict ⇒ already processed.
  const claim = await getPool().query<{ id: string }>(
    `INSERT INTO automation_run (clinic_id, rule_id, trigger_event_id, dedupe_key, status, attempts)
     VALUES ($1,$2,$3,$4,'pending',1)
     ON CONFLICT (rule_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [rule.clinicId, rule.id, event.id, dedupeKey],
  );
  if (claim.rows.length === 0) {
    return { result: 'already_ran' };
  }
  const runId = claim.rows[0]!.id;
  const context = toEventContext(event);

  // 2. Conditions. No match ⇒ record a skipped run and stop.
  if (!evaluateConditions(rule.conditions, context)) {
    await getPool().query(
      `UPDATE automation_run SET status = 'skipped', matched = false, finished_at = now() WHERE id = $1`,
      [runId],
    );
    return { result: 'skipped', runId };
  }

  // 3. Actions (sequential). Collect results; one failure fails the run but the
  //    idempotency claim ensures actions are not retried automatically.
  const results: ActionResult[] = [];
  let failure: string | null = null;
  for (let i = 0; i < rule.actions.length; i++) {
    const action = rule.actions[i]!;
    const handler = getActionHandler(action.type);
    if (!handler) {
      results.push({ type: action.type, status: 'error', error: 'unknown_action_type' });
      failure = failure ?? `unknown_action_type:${action.type}`;
      continue;
    }
    const ctx: ActionContext = {
      clinicId: rule.clinicId,
      event: context,
      ruleId: rule.id,
      runId,
      dedupeKey,
      actionIndex: i,
    };
    try {
      results.push(await handler.execute(action.params, ctx));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'action error';
      results.push({ type: action.type, status: 'error', error: message });
      failure = failure ?? message;
    }
  }

  const status = failure ? 'failed' : 'succeeded';
  await getPool().query(
    `UPDATE automation_run
        SET status = $2, action_results = $3, last_error = $4, finished_at = now()
      WHERE id = $1`,
    [runId, status, JSON.stringify(results), failure],
  );
  await audit({
    clinicId: rule.clinicId,
    actorId: null,
    action: 'automation.run',
    outcome: failure ? 'error' : 'success',
    targetType: 'automation_rule',
    targetId: rule.id,
    metadata: { runId, eventType: event.type, status },
  });

  return failure
    ? { result: 'failed', runId, actionResults: results, error: failure }
    : { result: 'succeeded', runId, actionResults: results };
}

export interface ProcessSummary {
  processed: number;
  triggered: number;
  lastEventId: number;
}

/**
 * Advance the engine over new events in the append-only store. Intended to be
 * called by a scheduler/worker on an interval, or on demand (tests, an admin
 * "process now"). Reads events with id > offset, runs matching enabled rules
 * for each, then advances the offset. The per-run idempotency guard means an
 * overlapping call cannot double-execute a rule.
 */
export async function processNewEvents(limit = 500): Promise<ProcessSummary> {
  // Serialize processors on the offset row; the run unique key is the real
  // correctness guard, this just avoids redundant work.
  return withTransaction(async (client) => {
    const offsetRes = await client.query<{ last_event_id: string }>(
      `INSERT INTO automation_offset (name, last_event_id) VALUES ($1, 0)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING last_event_id`,
      [OFFSET_NAME],
    );
    // Lock the row for the duration of processing.
    await client.query(`SELECT 1 FROM automation_offset WHERE name = $1 FOR UPDATE`, [OFFSET_NAME]);
    const startOffset = Number(offsetRes.rows[0]!.last_event_id);

    const events = await readEventsAfter(startOffset, limit);
    let triggered = 0;
    let lastEventId = startOffset;

    for (const event of events) {
      const rules = await findEnabledEventRules(event.clinicId, event.type);
      for (const rule of rules) {
        const outcome = await runRuleForEvent(rule, event);
        if (outcome.result === 'succeeded' || outcome.result === 'failed') triggered += 1;
      }
      lastEventId = event.id;
    }

    if (lastEventId > startOffset) {
      await client.query(
        `UPDATE automation_offset SET last_event_id = $2, updated_at = now() WHERE name = $1`,
        [OFFSET_NAME, lastEventId],
      );
    }
    return { processed: events.length, triggered, lastEventId };
  });
}
