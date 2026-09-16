import { getPool, type PoolClient } from '../../db/pool.js';
import type {
  Action,
  AutomationRule,
  AutomationRun,
  Condition,
  StoredEvent,
  TriggerType,
} from './automation.types.js';

/** Persistence for automation rules, runs, and the event-store read cursor. */

interface RuleRow {
  id: string;
  clinic_id: string;
  name: string;
  description: string | null;
  trigger_type: TriggerType;
  event_type: string | null;
  schedule_cron: string | null;
  conditions: Condition[];
  actions: Action[];
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export function mapRule(r: RuleRow): AutomationRule {
  return {
    id: r.id,
    clinicId: r.clinic_id,
    name: r.name,
    description: r.description,
    triggerType: r.trigger_type,
    eventType: r.event_type,
    scheduleCron: r.schedule_cron,
    conditions: r.conditions,
    actions: r.actions,
    isEnabled: r.is_enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface RunRow {
  id: string;
  clinic_id: string;
  rule_id: string;
  trigger_event_id: string | null;
  dedupe_key: string;
  status: AutomationRun['status'];
  matched: boolean;
  attempts: number;
  action_results: AutomationRun['actionResults'];
  last_error: string | null;
  started_at: string;
  finished_at: string | null;
}

export function mapRun(r: RunRow): AutomationRun {
  return {
    id: r.id,
    clinicId: r.clinic_id,
    ruleId: r.rule_id,
    triggerEventId: r.trigger_event_id === null ? null : Number(r.trigger_event_id),
    dedupeKey: r.dedupe_key,
    status: r.status,
    matched: r.matched,
    attempts: r.attempts,
    actionResults: r.action_results,
    lastError: r.last_error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export async function insertRule(
  client: PoolClient,
  clinicId: string,
  createdBy: string,
  input: {
    name: string;
    description?: string;
    triggerType: TriggerType;
    eventType?: string;
    scheduleCron?: string;
    conditions: Condition[];
    actions: Action[];
    isEnabled: boolean;
  },
): Promise<AutomationRule> {
  const { rows } = await client.query<RuleRow>(
    `INSERT INTO automation_rule
       (clinic_id, name, description, trigger_type, event_type, schedule_cron,
        conditions, actions, is_enabled, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      clinicId,
      input.name,
      input.description ?? null,
      input.triggerType,
      input.eventType ?? null,
      input.scheduleCron ?? null,
      JSON.stringify(input.conditions),
      JSON.stringify(input.actions),
      input.isEnabled,
      createdBy,
    ],
  );
  return mapRule(rows[0]!);
}

export async function getRuleById(clinicId: string, id: string): Promise<AutomationRule | null> {
  const { rows } = await getPool().query<RuleRow>(
    `SELECT * FROM automation_rule WHERE id = $1 AND clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapRule(rows[0]) : null;
}

export async function listRules(clinicId: string): Promise<AutomationRule[]> {
  const { rows } = await getPool().query<RuleRow>(
    `SELECT * FROM automation_rule WHERE clinic_id = $1 ORDER BY created_at DESC`,
    [clinicId],
  );
  return rows.map(mapRule);
}

/** Enabled event-triggered rules for a clinic + event type (the hot path). */
export async function findEnabledEventRules(
  clinicId: string,
  eventType: string,
): Promise<AutomationRule[]> {
  const { rows } = await getPool().query<RuleRow>(
    `SELECT * FROM automation_rule
      WHERE clinic_id = $1 AND is_enabled = true
        AND trigger_type = 'event' AND event_type = $2`,
    [clinicId, eventType],
  );
  return rows.map(mapRule);
}

export async function updateRule(
  client: PoolClient,
  clinicId: string,
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    conditions: Condition[];
    actions: Action[];
    isEnabled: boolean;
  }>,
): Promise<AutomationRule | null> {
  const { rows } = await client.query<RuleRow>(
    `UPDATE automation_rule SET
        name        = COALESCE($3, name),
        description = COALESCE($4, description),
        conditions = COALESCE($5, conditions),
        actions    = COALESCE($6, actions),
        is_enabled = COALESCE($7, is_enabled),
        updated_at = now()
      WHERE id = $1 AND clinic_id = $2
      RETURNING *`,
    [
      id,
      clinicId,
      patch.name ?? null,
      patch.description === undefined ? null : patch.description,
      patch.conditions ? JSON.stringify(patch.conditions) : null,
      patch.actions ? JSON.stringify(patch.actions) : null,
      patch.isEnabled ?? null,
    ],
  );
  return rows[0] ? mapRule(rows[0]) : null;
}

export async function deleteRule(client: PoolClient, clinicId: string, id: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `DELETE FROM automation_rule WHERE id = $1 AND clinic_id = $2`,
    [id, clinicId],
  );
  return (rowCount ?? 0) > 0;
}

export async function listRunsForRule(
  clinicId: string,
  ruleId: string,
  limit = 100,
): Promise<AutomationRun[]> {
  const { rows } = await getPool().query<RunRow>(
    `SELECT * FROM automation_run
      WHERE clinic_id = $1 AND rule_id = $2
      ORDER BY started_at DESC LIMIT $3`,
    [clinicId, ruleId, Math.min(limit, 500)],
  );
  return rows.map(mapRun);
}

// --- Event-store reads (read-only; the engine never writes to `event`) ------

interface EventRow {
  id: string;
  clinic_id: string;
  type: string;
  subject_type: string;
  subject_id: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
}

function mapEvent(r: EventRow): StoredEvent {
  return {
    id: Number(r.id),
    clinicId: r.clinic_id,
    type: r.type,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    actorId: r.actor_id,
    payload: r.payload,
    occurredAt: r.occurred_at,
  };
}

export async function readEventsAfter(afterId: number, limit: number): Promise<StoredEvent[]> {
  const { rows } = await getPool().query<EventRow>(
    `SELECT id, clinic_id, type, subject_type, subject_id, actor_id, payload, occurred_at
       FROM event WHERE id > $1 ORDER BY id ASC LIMIT $2`,
    [afterId, limit],
  );
  return rows.map(mapEvent);
}
