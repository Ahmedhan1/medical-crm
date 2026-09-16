import { z } from 'zod';
import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { getPatientById } from '../identity/patients.repo.js';
import { getEncounterOrThrow, TERMINAL_STATUSES } from './encounter.repo.js';

/**
 * The extensible observation engine (Phase 3).
 *
 * An observation records a value against an `observation_definition`, which
 * carries the value type, unit and reference range as DATA. That is the whole
 * point: a new specialty measurement is a definition row, not new code, and its
 * abnormal-value logic comes from the definition's range rather than a table
 * hard-coded in the service (as the universal vitals path necessarily does).
 *
 * This does not replace `vital`. The universal vital set stays on its fast,
 * CHECK-constrained path; observations are for everything else.
 */

export type ObservationValueType = 'quantity' | 'integer' | 'boolean' | 'text' | 'coded';

// ---------------------------------------------------------------------------
// Definition catalog
// ---------------------------------------------------------------------------
const numericTypes: readonly ObservationValueType[] = ['quantity', 'integer'];

export const ObservationDefinitionSchema = z
  .object({
    key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,62}$/, 'lower_snake_case key'),
    name: z.string().trim().min(1).max(160),
    category: z
      .enum(['vital', 'clinical', 'functional', 'scale', 'lab', 'other'])
      .default('clinical'),
    valueType: z.enum(['quantity', 'integer', 'boolean', 'text', 'coded']),
    unit: z.string().trim().min(1).max(32).optional(),
    minValue: z.number().optional(),
    maxValue: z.number().optional(),
    referenceLow: z.number().optional(),
    referenceHigh: z.number().optional(),
    allowedCodes: z.array(z.string().trim().min(1).max(64)).min(1).max(50).optional(),
  })
  .superRefine((v, ctx) => {
    const numeric = numericTypes.includes(v.valueType);
    if (v.valueType === 'quantity' && !v.unit) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unit'], message: 'A quantity needs a unit' });
    }
    if (!numeric && (v.minValue !== undefined || v.maxValue !== undefined || v.referenceLow !== undefined || v.referenceHigh !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['valueType'], message: 'Numeric bounds and ranges only apply to a quantity or integer' });
    }
    if (v.valueType === 'coded' && !v.allowedCodes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedCodes'], message: 'A coded observation needs allowedCodes' });
    }
    if (v.valueType !== 'coded' && v.allowedCodes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedCodes'], message: 'allowedCodes only apply to a coded observation' });
    }
    if (v.minValue !== undefined && v.maxValue !== undefined && v.maxValue < v.minValue) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxValue'], message: 'maxValue cannot be below minValue' });
    }
    if (v.referenceLow !== undefined && v.referenceHigh !== undefined && v.referenceHigh < v.referenceLow) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['referenceHigh'], message: 'referenceHigh cannot be below referenceLow' });
    }
  });

export interface ObservationDefinition {
  id: string;
  key: string;
  name: string;
  category: string;
  valueType: ObservationValueType;
  unit: string | null;
  minValue: number | null;
  maxValue: number | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  allowedCodes: string[] | null;
  isActive: boolean;
}

interface DefinitionRow {
  id: string;
  key: string;
  name: string;
  category: string;
  value_type: ObservationValueType;
  unit: string | null;
  min_value: string | null;
  max_value: string | null;
  reference_low: string | null;
  reference_high: string | null;
  allowed_codes: string[] | null;
  is_active: boolean;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function mapDefinition(r: DefinitionRow): ObservationDefinition {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    category: r.category,
    valueType: r.value_type,
    unit: r.unit,
    minValue: num(r.min_value),
    maxValue: num(r.max_value),
    referenceLow: num(r.reference_low),
    referenceHigh: num(r.reference_high),
    allowedCodes: r.allowed_codes,
    isActive: r.is_active,
  };
}

const DEFINITION_COLS = `id, key, name, category, value_type, unit, min_value, max_value,
  reference_low, reference_high, allowed_codes, is_active`;

export async function createObservationDefinition(
  principal: Principal,
  raw: unknown,
): Promise<ObservationDefinition> {
  requirePermission(principal, Permission.OBSERVATION_CONFIG_MANAGE);

  const parsed = ObservationDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid observation definition', parsed.error.flatten());
  }
  const d = parsed.data;

  return withTransaction(async (client) => {
    try {
      const { rows } = await client.query<DefinitionRow>(
        `INSERT INTO observation_definition
           (clinic_id, key, name, category, value_type, unit, min_value, max_value,
            reference_low, reference_high, allowed_codes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING ${DEFINITION_COLS}`,
        [
          principal.clinicId,
          d.key,
          d.name,
          d.category,
          d.valueType,
          d.unit ?? null,
          d.minValue ?? null,
          d.maxValue ?? null,
          d.referenceLow ?? null,
          d.referenceHigh ?? null,
          d.allowedCodes ? JSON.stringify(d.allowedCodes) : null,
          principal.userId,
        ],
      );
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'observation.definition.create',
        outcome: 'success',
        targetType: 'observation_definition',
        targetId: rows[0]!.id,
        metadata: { key: d.key, valueType: d.valueType },
      });
      return mapDefinition(rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('An observation definition with that key already exists');
      }
      throw err;
    }
  });
}

export async function listObservationDefinitions(
  principal: Principal,
  opts: { category?: string; includeInactive?: boolean } = {},
): Promise<ObservationDefinition[]> {
  requirePermission(principal, Permission.OBSERVATION_CONFIG_READ);
  const category = opts.category
    ? z.enum(['vital', 'clinical', 'functional', 'scale', 'lab', 'other']).parse(opts.category)
    : null;
  const { rows } = await getPool().query<DefinitionRow>(
    `SELECT ${DEFINITION_COLS} FROM observation_definition
      WHERE clinic_id = $1
        AND ($2::text IS NULL OR category = $2)
        AND ($3::boolean OR is_active)
      ORDER BY category, name`,
    [principal.clinicId, category, opts.includeInactive ?? false],
  );
  return rows.map(mapDefinition);
}

async function findDefinition(
  clinicId: string,
  definitionId: string,
  runner: Pick<PoolClient, 'query'>,
): Promise<ObservationDefinition | null> {
  const { rows } = await runner.query<DefinitionRow>(
    `SELECT ${DEFINITION_COLS} FROM observation_definition WHERE clinic_id = $1 AND id = $2`,
    [clinicId, definitionId],
  );
  return rows[0] ? mapDefinition(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Recording an observation
// ---------------------------------------------------------------------------
export const RecordObservationSchema = z.object({
  definitionId: z.string().uuid(),
  encounterId: z.string().uuid().optional(),
  /** One of these, matching the definition's value type. */
  valueNumber: z.number().optional(),
  valueText: z.string().trim().min(1).max(4_000).optional(),
  valueBoolean: z.boolean().optional(),
  valueCode: z.string().trim().min(1).max(64).optional(),
  performedAt: z.string().datetime({ offset: true }).optional(),
  source: z.enum(['staff', 'device', 'ai_assisted']).default('staff'),
  confirmed: z.boolean().optional(),
  notes: z.string().trim().max(2_000).optional(),
});

export interface Observation {
  id: string;
  definitionId: string;
  definitionKey: string;
  patientId: string;
  encounterId: string | null;
  valueNumber: number | null;
  valueText: string | null;
  valueBoolean: boolean | null;
  valueCode: string | null;
  unit: string | null;
  isAbnormal: boolean | null;
  performedAt: string;
  source: string;
  notes: string | null;
}

interface ObservationRow {
  id: string;
  definition_id: string;
  definition_key?: string;
  patient_id: string;
  encounter_id: string | null;
  value_number: string | null;
  value_text: string | null;
  value_boolean: boolean | null;
  value_code: string | null;
  unit: string | null;
  is_abnormal: boolean | null;
  performed_at: string;
  source: string;
  notes: string | null;
}

function mapObservation(r: ObservationRow): Observation {
  return {
    id: r.id,
    definitionId: r.definition_id,
    definitionKey: r.definition_key ?? '',
    patientId: r.patient_id,
    encounterId: r.encounter_id,
    valueNumber: num(r.value_number),
    valueText: r.value_text,
    valueBoolean: r.value_boolean,
    valueCode: r.value_code,
    unit: r.unit,
    isAbnormal: r.is_abnormal,
    performedAt: r.performed_at,
    source: r.source,
    notes: r.notes,
  };
}

/**
 * Coerce the supplied value to the definition's value type, validate it against
 * the definition's bounds/allowed codes, and compute the abnormal flag from the
 * reference range. Returns the column values plus the flag.
 *
 * This is where "extensible but still safe" lives: validation is driven by the
 * definition, so a clinic-defined observation is bounds-checked exactly like a
 * built-in one, without a code change.
 */
function resolveValue(
  def: ObservationDefinition,
  input: z.infer<typeof RecordObservationSchema>,
): {
  valueNumber: number | null;
  valueText: string | null;
  valueBoolean: boolean | null;
  valueCode: string | null;
  isAbnormal: boolean | null;
} {
  const supplied = [
    input.valueNumber !== undefined,
    input.valueText !== undefined,
    input.valueBoolean !== undefined,
    input.valueCode !== undefined,
  ].filter(Boolean).length;
  if (supplied !== 1) {
    throw new ValidationError('Supply exactly one value matching the definition value type');
  }

  switch (def.valueType) {
    case 'quantity':
    case 'integer': {
      if (input.valueNumber === undefined) {
        throw new ValidationError(`Observation "${def.key}" expects a numeric value`);
      }
      let value = input.valueNumber;
      if (def.valueType === 'integer') {
        if (!Number.isInteger(value)) {
          throw new ValidationError(`Observation "${def.key}" expects an integer`);
        }
      } else {
        value = Number(value);
      }
      if (def.minValue !== null && value < def.minValue) {
        throw new ValidationError(`Value below the allowed minimum (${def.minValue})`);
      }
      if (def.maxValue !== null && value > def.maxValue) {
        throw new ValidationError(`Value above the allowed maximum (${def.maxValue})`);
      }
      let isAbnormal: boolean | null = null;
      if (def.referenceLow !== null || def.referenceHigh !== null) {
        isAbnormal =
          (def.referenceLow !== null && value < def.referenceLow) ||
          (def.referenceHigh !== null && value > def.referenceHigh);
      }
      return { valueNumber: value, valueText: null, valueBoolean: null, valueCode: null, isAbnormal };
    }
    case 'boolean': {
      if (input.valueBoolean === undefined) {
        throw new ValidationError(`Observation "${def.key}" expects a boolean value`);
      }
      return { valueNumber: null, valueText: null, valueBoolean: input.valueBoolean, valueCode: null, isAbnormal: null };
    }
    case 'text': {
      if (input.valueText === undefined) {
        throw new ValidationError(`Observation "${def.key}" expects a text value`);
      }
      return { valueNumber: null, valueText: input.valueText, valueBoolean: null, valueCode: null, isAbnormal: null };
    }
    case 'coded': {
      if (input.valueCode === undefined) {
        throw new ValidationError(`Observation "${def.key}" expects a code`);
      }
      if (!def.allowedCodes?.includes(input.valueCode)) {
        throw new ValidationError(`"${input.valueCode}" is not an allowed code for "${def.key}"`, {
          allowed: def.allowedCodes,
        });
      }
      return { valueNumber: null, valueText: null, valueBoolean: null, valueCode: input.valueCode, isAbnormal: null };
    }
  }
}

export async function recordObservation(
  principal: Principal,
  raw: unknown,
): Promise<Observation> {
  requirePermission(principal, Permission.OBSERVATION_RECORD);

  const parsed = RecordObservationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid observation', parsed.error.flatten());
  }
  const input = parsed.data;

  if (input.source === 'ai_assisted' && input.confirmed !== true) {
    throw new ValidationError(
      'An AI-assisted observation must be confirmed by a human reviewer before it is written',
    );
  }

  return withTransaction(async (client) => {
    const def = await findDefinition(principal.clinicId, input.definitionId, client);
    if (!def) throw new NotFoundError('Observation definition');
    if (!def.isActive) throw new ConflictError('That observation definition is not active');

    // Resolve the patient/encounter. An encounter, when given, must belong to
    // the patient it is recorded against and must not be closed.
    let patientId: string;
    let encounterId: string | null = null;
    if (input.encounterId) {
      const encounter = await getEncounterOrThrow(principal.clinicId, input.encounterId);
      if (TERMINAL_STATUSES.includes(encounter.status)) {
        throw new ConflictError(`Encounter is ${encounter.status}; observations can no longer be added`);
      }
      encounterId = encounter.id;
      patientId = encounter.patientId;
    } else {
      throw new ValidationError('An encounterId is required to record an observation');
    }

    const patient = await getPatientById(principal.clinicId, patientId);
    if (!patient) throw new NotFoundError('Patient');

    const resolved = resolveValue(def, input);

    const { rows } = await client.query<ObservationRow>(
      `INSERT INTO observation
         (clinic_id, definition_id, patient_id, encounter_id, value_number, value_text,
          value_boolean, value_code, unit, is_abnormal, performed_at, source, confirmed_by,
          notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz, now()),$12,$13,$14,$15)
       RETURNING id, definition_id, patient_id, encounter_id, value_number, value_text,
                 value_boolean, value_code, unit, is_abnormal, performed_at, source, notes`,
      [
        principal.clinicId,
        def.id,
        patientId,
        encounterId,
        resolved.valueNumber,
        resolved.valueText,
        resolved.valueBoolean,
        resolved.valueCode,
        def.unit,
        resolved.isAbnormal,
        input.performedAt ?? null,
        input.source,
        input.source === 'ai_assisted' ? principal.userId : null,
        input.notes ?? null,
        principal.userId,
      ],
    );
    const observation = { ...mapObservation(rows[0]!), definitionKey: def.key };

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.OBSERVATION_RECORDED,
      subjectType: 'encounter',
      subjectId: encounterId,
      actorId: principal.userId,
      // Identifiers, the definition KEY (a controlled config identifier, not
      // PHI) and the abnormal flag. The measured value stays in the record.
      payload: {
        patientId,
        observationId: observation.id,
        definitionKey: def.key,
        abnormal: resolved.isAbnormal ?? false,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'observation.record',
      outcome: 'success',
      targetType: 'observation',
      targetId: observation.id,
      metadata: { patientId, definitionKey: def.key, source: input.source },
    });

    return observation;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
const OBSERVATION_SELECT = `
  SELECT o.id, o.definition_id, d.key AS definition_key, o.patient_id, o.encounter_id,
         o.value_number, o.value_text, o.value_boolean, o.value_code, o.unit,
         o.is_abnormal, o.performed_at, o.source, o.notes
    FROM observation o
    JOIN observation_definition d ON d.id = o.definition_id`;

export async function listEncounterObservations(
  principal: Principal,
  encounterId: string,
): Promise<Observation[]> {
  requirePermission(principal, Permission.OBSERVATION_READ);
  const encounter = await getEncounterOrThrow(principal.clinicId, encounterId);
  const { rows } = await getPool().query<ObservationRow>(
    `${OBSERVATION_SELECT}
      WHERE o.clinic_id = $1 AND o.encounter_id = $2
      ORDER BY o.performed_at DESC, o.id DESC`,
    [principal.clinicId, encounter.id],
  );
  return rows.map(mapObservation);
}

export const PatientObservationQuery = z.object({
  definitionKey: z.string().trim().regex(/^[a-z][a-z0-9_]{1,62}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function listPatientObservations(
  principal: Principal,
  patientId: string,
  rawQuery: unknown,
): Promise<Observation[]> {
  requirePermission(principal, Permission.OBSERVATION_READ);

  const parsed = PatientObservationQuery.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());

  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');

  const { rows } = await getPool().query<ObservationRow>(
    `${OBSERVATION_SELECT}
      WHERE o.clinic_id = $1 AND o.patient_id = $2
        AND ($3::text IS NULL OR d.key = $3)
      ORDER BY o.performed_at DESC, o.id DESC
      LIMIT $4`,
    [principal.clinicId, patient.id, parsed.data.definitionKey ?? null, parsed.data.limit],
  );
  return rows.map(mapObservation);
}
