import { z } from 'zod';
import { withTransaction } from '../../db/pool.js';
import { ConflictError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import {
  getEncounterOrThrow,
  lockEncounter,
  TERMINAL_STATUSES,
} from './encounter.repo.js';
import {
  insertVital,
  listVitalsByEncounter,
  listRecentPatientVitals,
  type Vital,
} from './vitals.repo.js';

/**
 * Vital-sign bounds. These mirror the CHECK constraints in migration 0100:
 * the schema is the last line of defence, this is the friendly one. Bounds are
 * "physiologically possible", not "normal" — flagging abnormal-but-possible
 * values is a clinical signal (see `abnormalFlags`), not a validation failure.
 */
const int = (min: number, max: number) => z.number().int().min(min).max(max).nullish();
const dec = (min: number, max: number) => z.number().min(min).max(max).nullish();

export const RecordVitalsSchema = z
  .object({
    systolicBp: int(40, 300),
    diastolicBp: int(20, 200),
    heartRate: int(20, 300),
    respiratoryRate: int(4, 80),
    temperatureC: dec(25, 45),
    spo2: int(50, 100),
    weightKg: dec(0.2, 500),
    heightCm: dec(20, 260),
    bloodGlucoseMgdl: int(10, 1000),
    painScore: int(0, 10),
    notes: z.string().trim().max(2_000).optional(),
  })
  .refine(
    (v) =>
      [
        v.systolicBp,
        v.diastolicBp,
        v.heartRate,
        v.respiratoryRate,
        v.temperatureC,
        v.spo2,
        v.weightKg,
        v.heightCm,
        v.bloodGlucoseMgdl,
        v.painScore,
      ].some((x) => x !== null && x !== undefined),
    { message: 'At least one vital sign must be provided' },
  )
  .refine((v) => (v.systolicBp ?? null) === null === ((v.diastolicBp ?? null) === null), {
    message: 'Blood pressure requires both systolicBp and diastolicBp',
    path: ['systolicBp'],
  })
  .refine((v) => v.systolicBp == null || v.diastolicBp == null || v.systolicBp > v.diastolicBp, {
    message: 'systolicBp must be greater than diastolicBp',
    path: ['systolicBp'],
  });

export type RecordVitalsInput = z.input<typeof RecordVitalsSchema>;

/** Adult reference ranges used to flag values that warrant clinical attention. */
const NORMAL_RANGES: Record<string, [number, number]> = {
  systolicBp: [90, 140],
  diastolicBp: [60, 90],
  heartRate: [50, 100],
  respiratoryRate: [12, 20],
  temperatureC: [36, 37.8],
  spo2: [94, 100],
};

/**
 * Names of the measurements outside their reference range. Returns FIELD NAMES
 * ONLY — never the values — so downstream automation can react to "this visit
 * has abnormal observations" without the measurements leaking into the event
 * payload or anywhere else outside the clinical record.
 */
export function abnormalFlags(vital: Vital): string[] {
  const flags: string[] = [];
  for (const [field, [lo, hi]] of Object.entries(NORMAL_RANGES)) {
    const value = vital[field as keyof Vital];
    if (typeof value === 'number' && (value < lo || value > hi)) flags.push(field);
  }
  return flags;
}

/**
 * Record one set of vital signs against an encounter. Vitals are additive: a
 * re-check during the same visit is a new row, never an overwrite, so the
 * observation history stays intact.
 */
export async function recordVitals(
  principal: Principal,
  encounterId: string,
  raw: unknown,
): Promise<{ vital: Vital; abnormal: string[] }> {
  requirePermission(principal, Permission.VITALS_RECORD);

  const parsed = RecordVitalsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid vital signs', parsed.error.flatten());
  }
  const v = parsed.data;

  return withTransaction(async (client) => {
    const encounter = await lockEncounter(client, principal.clinicId, encounterId);
    if (TERMINAL_STATUSES.includes(encounter.status)) {
      throw new ConflictError(`Encounter is ${encounter.status}; vitals can no longer be recorded`);
    }

    const vital = await insertVital(client, {
      clinicId: principal.clinicId,
      encounterId: encounter.id,
      patientId: encounter.patientId,
      systolicBp: v.systolicBp ?? null,
      diastolicBp: v.diastolicBp ?? null,
      heartRate: v.heartRate ?? null,
      respiratoryRate: v.respiratoryRate ?? null,
      temperatureC: v.temperatureC ?? null,
      spo2: v.spo2 ?? null,
      weightKg: v.weightKg ?? null,
      heightCm: v.heightCm ?? null,
      bloodGlucoseMgdl: v.bloodGlucoseMgdl ?? null,
      painScore: v.painScore ?? null,
      notes: v.notes ?? null,
      recordedBy: principal.userId,
    });

    const abnormal = abnormalFlags(vital);

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.VITALS_RECORDED,
      subjectType: 'encounter',
      subjectId: encounter.id,
      actorId: principal.userId,
      // Identifiers plus abnormal FIELD NAMES only — no measured values.
      payload: { patientId: encounter.patientId, vitalId: vital.id, abnormal },
    });

    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'vitals.record',
      outcome: 'success',
      targetType: 'encounter',
      targetId: encounter.id,
      metadata: { patientId: encounter.patientId, vitalId: vital.id },
    });

    return { vital, abnormal };
  });
}

export async function listVitals(principal: Principal, encounterId: string): Promise<Vital[]> {
  requirePermission(principal, Permission.VITALS_READ);
  const encounter = await getEncounterOrThrow(principal.clinicId, encounterId);
  return listVitalsByEncounter(principal.clinicId, encounter.id);
}

/**
 * The patient's most recent vital sets across all encounters — the longitudinal
 * view used by Patient 360. Same VITALS_READ gate as the per-encounter read.
 */
export async function listPatientVitals(
  principal: Principal,
  patientId: string,
  opts: { limit?: number } = {},
): Promise<Vital[]> {
  requirePermission(principal, Permission.VITALS_READ);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  return listRecentPatientVitals(principal.clinicId, patientId, limit);
}
