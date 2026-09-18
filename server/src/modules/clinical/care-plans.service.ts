import { z } from 'zod';
import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { getPatientById } from '../identity/patients.repo.js';
import { findEncounter } from './encounter.repo.js';
import { resolvePatientLineage } from '../identity/patients.lifecycle.service.js';
import { toIsoDate } from './dates.js';

/**
 * Care plans (FHIR CarePlan-aligned): a plan for a patient, optionally tied to a
 * treatment episode, carrying goals and interventions with explicit,
 * deterministic statuses. Progress is always an explicit status change, never
 * inferred. Authoring is doctor-owned (`care_plan:write`); recording progress on
 * goals/activities is open to nurses too (`care_plan:progress`).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

const PLAN_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ['active', 'revoked'],
  active: ['on_hold', 'completed', 'revoked'],
  on_hold: ['active', 'revoked'],
  completed: [],
  revoked: [],
};

// ---- schemas ---------------------------------------------------------------
export const CreateCarePlanSchema = z.object({
  patientId: z.string().uuid(),
  episodeId: z.string().uuid().optional(),
  encounterId: z.string().uuid().optional(),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(4_000).optional(),
  intent: z.enum(['proposal', 'plan', 'order']).default('plan'),
  periodStart: isoDate,
  periodEnd: isoDate.optional(),
  goals: z.array(z.object({ description: z.string().trim().min(2).max(500), targetDate: isoDate.optional() })).max(50).optional(),
  activities: z.array(z.object({ description: z.string().trim().min(2).max(500), kind: z.string().trim().max(80).optional(), scheduledDate: isoDate.optional() })).max(50).optional(),
});
export const PlanStatusSchema = z.object({ status: z.enum(['active', 'on_hold', 'completed', 'revoked']), reason: z.string().trim().max(500).optional() });
export const AddGoalSchema = z.object({ description: z.string().trim().min(2).max(500), targetDate: isoDate.optional() });
export const GoalProgressSchema = z.object({ status: z.enum(['active', 'on_hold', 'achieved', 'cancelled']), progressNote: z.string().trim().max(2_000).optional() });
export const AddActivitySchema = z.object({ description: z.string().trim().min(2).max(500), kind: z.string().trim().max(80).optional(), scheduledDate: isoDate.optional() });
export const ActivityProgressSchema = z.object({ status: z.enum(['scheduled', 'in_progress', 'completed', 'cancelled']), progressNote: z.string().trim().max(2_000).optional() });

// ---- types -----------------------------------------------------------------
export interface CareGoal { id: string; description: string; status: string; targetDate: string | null; achievedAt: string | null; progressNote: string | null; }
export interface CareActivity { id: string; description: string; kind: string | null; status: string; scheduledDate: string | null; progressNote: string | null; }
export interface CarePlan {
  id: string; patientId: string; episodeId: string | null; originEncounterId: string | null;
  title: string; description: string | null; intent: string; status: string;
  periodStart: string; periodEnd: string | null; createdAt: string;
  goals?: CareGoal[]; activities?: CareActivity[];
}

const planCols = `id, patient_id, episode_id, origin_encounter_id, title, description, intent, status, period_start, period_end, created_at`;
function mapPlan(r: any): CarePlan {
  return { id: r.id, patientId: r.patient_id, episodeId: r.episode_id, originEncounterId: r.origin_encounter_id, title: r.title, description: r.description, intent: r.intent, status: r.status, periodStart: toIsoDate(r.period_start)!, periodEnd: toIsoDate(r.period_end), createdAt: r.created_at };
}
const mapGoal = (r: any): CareGoal => ({ id: r.id, description: r.description, status: r.status, targetDate: toIsoDate(r.target_date), achievedAt: r.achieved_at, progressNote: r.progress_note });
const mapActivity = (r: any): CareActivity => ({ id: r.id, description: r.description, kind: r.kind, status: r.status, scheduledDate: toIsoDate(r.scheduled_date), progressNote: r.progress_note });

async function loadPlanRow(runner: Pick<PoolClient, 'query'>, clinicId: string, planId: string): Promise<CarePlan | null> {
  const { rows } = await runner.query(`SELECT ${planCols} FROM care_plan WHERE id = $1 AND clinic_id = $2`, [planId, clinicId]);
  return rows[0] ? mapPlan(rows[0]) : null;
}

// ---- create ----------------------------------------------------------------
export async function createCarePlan(principal: Principal, raw: unknown): Promise<CarePlan> {
  requirePermission(principal, Permission.CARE_PLAN_WRITE);
  const parsed = CreateCarePlanSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid care plan', parsed.error.flatten());
  const input = parsed.data;

  const patient = await getPatientById(principal.clinicId, input.patientId);
  if (!patient) throw new NotFoundError('Patient');
  if (patient.status === 'merged') throw new ConflictError('This record was merged; plan the surviving patient', { mergedIntoId: patient.mergedIntoId });
  if (input.periodEnd && input.periodEnd < input.periodStart) throw new ValidationError('periodEnd cannot precede periodStart');

  return withTransaction(async (client) => {
    if (input.encounterId) {
      const e = await findEncounter(principal.clinicId, input.encounterId);
      if (!e || e.patientId !== patient.id) throw new ValidationError('encounterId does not belong to this patient');
    }
    if (input.episodeId) {
      const lineage = await resolvePatientLineage(principal.clinicId, patient.id, client);
      const { rows } = await client.query(`SELECT id FROM treatment_episode WHERE id = $1 AND clinic_id = $2 AND patient_id = ANY($3::uuid[])`, [input.episodeId, principal.clinicId, lineage]);
      if (!rows[0]) throw new ValidationError('episodeId does not belong to this patient');
    }

    const { rows } = await client.query(
      `INSERT INTO care_plan (clinic_id, patient_id, episode_id, origin_encounter_id, title, description, intent, period_start, period_end, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${planCols}`,
      [principal.clinicId, patient.id, input.episodeId ?? null, input.encounterId ?? null, input.title, input.description ?? null, input.intent, input.periodStart, input.periodEnd ?? null, principal.userId],
    );
    const plan = mapPlan(rows[0]);

    for (const g of input.goals ?? []) {
      await client.query(`INSERT INTO care_goal (clinic_id, care_plan_id, patient_id, description, target_date, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [principal.clinicId, plan.id, patient.id, g.description, g.targetDate ?? null, principal.userId]);
    }
    for (const a of input.activities ?? []) {
      await client.query(`INSERT INTO care_plan_activity (clinic_id, care_plan_id, patient_id, description, kind, scheduled_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [principal.clinicId, plan.id, patient.id, a.description, a.kind ?? null, a.scheduledDate ?? null, principal.userId]);
    }

    await emitEvent(client, { clinicId: principal.clinicId, type: EventType.CARE_PLAN_CREATED, subjectType: 'care_plan', subjectId: plan.id, actorId: principal.userId,
      payload: { patientId: patient.id, intent: plan.intent, goalCount: (input.goals ?? []).length, activityCount: (input.activities ?? []).length } });
    await auditTx(client, { clinicId: principal.clinicId, actorId: principal.userId, action: 'care_plan.create', outcome: 'success', targetType: 'care_plan', targetId: plan.id, metadata: { patientId: patient.id, intent: plan.intent } });

    return (await getCarePlanTx(client, principal.clinicId, plan.id))!;
  });
}

async function getCarePlanTx(client: Pick<PoolClient, 'query'>, clinicId: string, planId: string): Promise<CarePlan | null> {
  const plan = await loadPlanRow(client, clinicId, planId);
  if (!plan) return null;
  const goals = await client.query(`SELECT id, description, status, target_date, achieved_at, progress_note FROM care_goal WHERE care_plan_id = $1 AND clinic_id = $2 ORDER BY created_at`, [planId, clinicId]);
  const acts = await client.query(`SELECT id, description, kind, status, scheduled_date, progress_note FROM care_plan_activity WHERE care_plan_id = $1 AND clinic_id = $2 ORDER BY created_at`, [planId, clinicId]);
  plan.goals = goals.rows.map(mapGoal);
  plan.activities = acts.rows.map(mapActivity);
  return plan;
}

// ---- plan status -----------------------------------------------------------
export async function setCarePlanStatus(principal: Principal, planId: string, raw: unknown): Promise<CarePlan> {
  requirePermission(principal, Permission.CARE_PLAN_WRITE);
  const parsed = PlanStatusSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid status', parsed.error.flatten());
  const { status: to } = parsed.data;

  return withTransaction(async (client) => {
    const { rows: locked } = await client.query(`SELECT ${planCols} FROM care_plan WHERE id = $1 AND clinic_id = $2 FOR UPDATE`, [planId, principal.clinicId]);
    if (!locked[0]) throw new NotFoundError('Care plan');
    const existing = mapPlan(locked[0]);
    if (existing.status === to) throw new ConflictError(`Care plan is already ${to}`);
    if (!PLAN_TRANSITIONS[existing.status]!.includes(to)) throw new ConflictError(`Cannot move a care plan from ${existing.status} to ${to}`, { from: existing.status, allowed: PLAN_TRANSITIONS[existing.status] });

    await client.query(`UPDATE care_plan SET status = $3, updated_by = $4, updated_at = now() WHERE id = $1 AND clinic_id = $2`, [planId, principal.clinicId, to, principal.userId]);
    await emitEvent(client, { clinicId: principal.clinicId, type: EventType.CARE_PLAN_STATUS_CHANGED, subjectType: 'care_plan', subjectId: planId, actorId: principal.userId, payload: { patientId: existing.patientId, from: existing.status, to } });
    await auditTx(client, { clinicId: principal.clinicId, actorId: principal.userId, action: 'care_plan.status', outcome: 'success', targetType: 'care_plan', targetId: planId, metadata: { patientId: existing.patientId, from: existing.status, to } });
    return (await getCarePlanTx(client, principal.clinicId, planId))!;
  });
}

// ---- goals -----------------------------------------------------------------
async function lockPlanForChild(client: PoolClient, clinicId: string, planId: string): Promise<CarePlan> {
  const { rows } = await client.query(`SELECT ${planCols} FROM care_plan WHERE id = $1 AND clinic_id = $2 FOR UPDATE`, [planId, clinicId]);
  if (!rows[0]) throw new NotFoundError('Care plan');
  const plan = mapPlan(rows[0]);
  if (plan.status === 'completed' || plan.status === 'revoked') throw new ConflictError(`A ${plan.status} care plan can no longer be changed`);
  return plan;
}

export async function addGoal(principal: Principal, planId: string, raw: unknown): Promise<CareGoal> {
  requirePermission(principal, Permission.CARE_PLAN_WRITE);
  const parsed = AddGoalSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid goal', parsed.error.flatten());
  return withTransaction(async (client) => {
    const plan = await lockPlanForChild(client, principal.clinicId, planId);
    const { rows } = await client.query(`INSERT INTO care_goal (clinic_id, care_plan_id, patient_id, description, target_date, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, description, status, target_date, achieved_at, progress_note`,
      [principal.clinicId, planId, plan.patientId, parsed.data.description, parsed.data.targetDate ?? null, principal.userId]);
    await auditTx(client, { clinicId: principal.clinicId, actorId: principal.userId, action: 'care_plan.goal.add', outcome: 'success', targetType: 'care_plan', targetId: planId, metadata: { patientId: plan.patientId } });
    return mapGoal(rows[0]);
  });
}

export async function updateGoalProgress(principal: Principal, planId: string, goalId: string, raw: unknown): Promise<CareGoal> {
  requirePermission(principal, Permission.CARE_PLAN_PROGRESS);
  const parsed = GoalProgressSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid progress', parsed.error.flatten());
  const { status: to, progressNote } = parsed.data;
  return withTransaction(async (client) => {
    const { rows: locked } = await client.query(`SELECT g.id, g.status, g.patient_id FROM care_goal g WHERE g.id = $1 AND g.care_plan_id = $2 AND g.clinic_id = $3 FOR UPDATE`, [goalId, planId, principal.clinicId]);
    if (!locked[0]) throw new NotFoundError('Goal');
    const before = locked[0];
    const { rows } = await client.query(
      `UPDATE care_goal SET status = $3, achieved_at = CASE WHEN $3 = 'achieved' THEN COALESCE(achieved_at, now()) ELSE NULL END,
          progress_note = COALESCE($4, progress_note), updated_by = $5, updated_at = now()
        WHERE id = $1 AND clinic_id = $2 RETURNING id, description, status, target_date, achieved_at, progress_note`,
      [goalId, principal.clinicId, to, progressNote ?? null, principal.userId]);
    if (to === 'achieved' && before.status !== 'achieved') {
      await emitEvent(client, { clinicId: principal.clinicId, type: EventType.CARE_GOAL_ACHIEVED, subjectType: 'care_plan', subjectId: planId, actorId: principal.userId, payload: { patientId: before.patient_id, goalId } });
    }
    await auditTx(client, { clinicId: principal.clinicId, actorId: principal.userId, action: 'care_plan.goal.progress', outcome: 'success', targetType: 'care_plan', targetId: planId, metadata: { patientId: before.patient_id, goalId, from: before.status, to } });
    return mapGoal(rows[0]);
  });
}

// ---- activities ------------------------------------------------------------
export async function addActivity(principal: Principal, planId: string, raw: unknown): Promise<CareActivity> {
  requirePermission(principal, Permission.CARE_PLAN_WRITE);
  const parsed = AddActivitySchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid activity', parsed.error.flatten());
  return withTransaction(async (client) => {
    const plan = await lockPlanForChild(client, principal.clinicId, planId);
    const { rows } = await client.query(`INSERT INTO care_plan_activity (clinic_id, care_plan_id, patient_id, description, kind, scheduled_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, description, kind, status, scheduled_date, progress_note`,
      [principal.clinicId, planId, plan.patientId, parsed.data.description, parsed.data.kind ?? null, parsed.data.scheduledDate ?? null, principal.userId]);
    await auditTx(client, { clinicId: principal.clinicId, actorId: principal.userId, action: 'care_plan.activity.add', outcome: 'success', targetType: 'care_plan', targetId: planId, metadata: { patientId: plan.patientId } });
    return mapActivity(rows[0]);
  });
}

export async function updateActivityProgress(principal: Principal, planId: string, activityId: string, raw: unknown): Promise<CareActivity> {
  requirePermission(principal, Permission.CARE_PLAN_PROGRESS);
  const parsed = ActivityProgressSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid progress', parsed.error.flatten());
  return withTransaction(async (client) => {
    const { rows: locked } = await client.query(`SELECT id, status, patient_id FROM care_plan_activity WHERE id = $1 AND care_plan_id = $2 AND clinic_id = $3 FOR UPDATE`, [activityId, planId, principal.clinicId]);
    if (!locked[0]) throw new NotFoundError('Activity');
    const before = locked[0];
    const { rows } = await client.query(`UPDATE care_plan_activity SET status = $3, progress_note = COALESCE($4, progress_note), updated_by = $5, updated_at = now() WHERE id = $1 AND clinic_id = $2 RETURNING id, description, kind, status, scheduled_date, progress_note`,
      [activityId, principal.clinicId, parsed.data.status, parsed.data.progressNote ?? null, principal.userId]);
    await auditTx(client, { clinicId: principal.clinicId, actorId: principal.userId, action: 'care_plan.activity.progress', outcome: 'success', targetType: 'care_plan', targetId: planId, metadata: { patientId: before.patient_id, activityId, from: before.status, to: parsed.data.status } });
    return mapActivity(rows[0]);
  });
}

// ---- reads -----------------------------------------------------------------
export async function getCarePlan(principal: Principal, planId: string): Promise<CarePlan> {
  requirePermission(principal, Permission.CARE_PLAN_READ);
  const plan = await getCarePlanTx(getPool(), principal.clinicId, planId);
  if (!plan) throw new NotFoundError('Care plan');
  return plan;
}

export const ListCarePlansQuery = z.object({ status: z.enum(['draft', 'active', 'on_hold', 'completed', 'revoked']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

export async function listPatientCarePlans(principal: Principal, patientId: string, rawQuery: unknown): Promise<CarePlan[]> {
  requirePermission(principal, Permission.CARE_PLAN_READ);
  const parsed = ListCarePlansQuery.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());
  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');
  const lineage = await resolvePatientLineage(principal.clinicId, patient.id);
  const { rows } = await getPool().query(`SELECT ${planCols} FROM care_plan WHERE clinic_id = $1 AND patient_id = ANY($2::uuid[]) AND ($3::text IS NULL OR status = $3) ORDER BY created_at DESC LIMIT $4`,
    [principal.clinicId, lineage, parsed.data.status ?? null, parsed.data.limit]);
  return rows.map(mapPlan);
}
