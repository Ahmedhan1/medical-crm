import { getPool } from '../../../db/pool.js';
import { DataClass } from '../classification.js';
import { RiskClass } from './risk.js';
import type { AiTool, AiToolContext } from './tools.js';

/**
 * Bounded READ-ONLY AI tools (E5).
 *
 * Real, non-destructive read capabilities over data Agent 3 owns (automation
 * runs, message delivery status) plus NON-PHI foundation info (clinic
 * name/timezone). Every call is clinic-scoped from the Action Guard context and
 * returns aggregates/labels only — NO PHI, NO message bodies, NO recipients.
 *
 * These run through `executeAiAction` → the Action Guard, which enforces the AI
 * identity, scope, risk ceiling, data classification and tenant AI policy. They
 * perform NO mutation and never read a clinical/patient/pharma table. Reads over
 * PHI clinical data remain authorization-only (handler-less) pending a CCR.
 */

const clinicInfoRead: AiTool = {
  id: 'clinic.info.read',
  name: 'Read clinic information',
  description: 'Non-PHI clinic profile (name, timezone). For administrative assistance.',
  access: 'read',
  requiredScope: 'read:clinic-info',
  dataCeiling: DataClass.INTERNAL,
  risk: RiskClass.READ_ONLY,
  requiresConfirmation: false,
  enabled: true,
  handler: async (ctx: AiToolContext) => {
    const { rows } = await getPool().query<{ name: string; timezone: string }>(
      `SELECT name, timezone FROM clinic WHERE id = $1`,
      [ctx.clinicId],
    );
    const c = rows[0];
    if (!c) return { found: false };
    return { found: true, clinicId: ctx.clinicId, name: c.name, timezone: c.timezone };
  },
};

const automationRunsRead: AiTool = {
  id: 'automation.runs.read',
  name: 'Read automation run status',
  description: 'Aggregated automation run counts + recent run outcomes (no PHI).',
  access: 'read',
  requiredScope: 'read:automation-runs',
  dataCeiling: DataClass.OPERATIONAL,
  risk: RiskClass.READ_ONLY,
  requiresConfirmation: false,
  enabled: true,
  handler: async (ctx: AiToolContext) => {
    const counts = await getPool().query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM automation_run WHERE clinic_id = $1 GROUP BY status`,
      [ctx.clinicId],
    );
    const recent = await getPool().query<{ rule_id: string; status: string; started_at: string }>(
      `SELECT rule_id, status, started_at FROM automation_run
        WHERE clinic_id = $1 ORDER BY started_at DESC LIMIT 10`,
      [ctx.clinicId],
    );
    return {
      countsByStatus: Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.n)])),
      recent: recent.rows.map((r) => ({ ruleId: r.rule_id, status: r.status, startedAt: r.started_at })),
    };
  },
};

const messagingStatusRead: AiTool = {
  id: 'messaging.status.read',
  name: 'Read messaging delivery status',
  description: 'Aggregated message delivery counts by status (no recipients, no bodies, no PHI).',
  access: 'read',
  requiredScope: 'read:messaging-status',
  dataCeiling: DataClass.OPERATIONAL,
  risk: RiskClass.READ_ONLY,
  requiresConfirmation: false,
  enabled: true,
  handler: async (ctx: AiToolContext) => {
    const { rows } = await getPool().query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM message_log WHERE clinic_id = $1 GROUP BY status`,
      [ctx.clinicId],
    );
    return { countsByStatus: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) };
  },
};

/** The bounded read-only data tools, seeded into the registry as built-ins. */
export const READONLY_DATA_TOOLS: AiTool[] = [clinicInfoRead, automationRunsRead, messagingStatusRead];
