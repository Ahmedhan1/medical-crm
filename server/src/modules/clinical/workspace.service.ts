import { z } from 'zod';
import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { hasPermission, requirePermission, type Principal } from '../governance/rbac.js';
import { getPatientById } from '../identity/patients.repo.js';
import {
  getEncounterOrThrow,
  lockEncounter,
  TERMINAL_STATUSES,
  type Encounter,
} from './encounter.repo.js';
import { applyStatusTx } from './status.service.js';
import { syncAppointmentFromEncounterTx } from './scheduling.service.js';
import { getIntakeByEncounter, type Intake } from './intake.repo.js';
import { listVitalsByEncounter, type Vital } from './vitals.repo.js';
import { listEncounterPrescriptions, type Prescription } from './prescriptions.service.js';
import { listFollowUpsByEncounter, type FollowUp } from './followups.service.js';
import {
  ensureEncounterClinical,
  findDiagnosis,
  getAssessment,
  getEncounterClinical,
  getTreatmentPlan,
  insertDiagnosis,
  insertNote,
  listDiagnoses,
  listNotes,
  markCompleted,
  markStarted,
  updateDiagnosis,
  updateEncounterClinical,
  upsertAssessment,
  upsertTreatmentPlan,
  type Assessment,
  type ClinicalNote,
  type Diagnosis,
  type EncounterClinical,
  type TreatmentPlan,
} from './encounter.clinical.repo.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const optionalText = (max: number) => z.string().trim().max(max).nullish();

export const ClinicalPatchSchema = z
  .object({
    complaint: optionalText(2_000),
    examination: optionalText(8_000),
    assessment: z
      .object({
        summary: z.string().trim().min(2).max(8_000),
        severity: z.enum(['mild', 'moderate', 'severe', 'critical']).nullish(),
      })
      .optional(),
    treatmentPlan: z
      .object({
        summary: z.string().trim().min(2).max(8_000),
        instructions: optionalText(8_000),
        followUpInDays: z.number().int().min(1).max(3650).nullish(),
      })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No clinical fields supplied' });

export const DiagnosisSchema = z
  .object({
    description: z.string().trim().min(2).max(500),
    codeSystem: z.enum(['ICD-10', 'ICD-11', 'SNOMED-CT', 'local']).nullish(),
    code: z.string().trim().min(1).max(40).nullish(),
    category: z.enum(['primary', 'secondary', 'differential']).default('primary'),
    certainty: z.enum(['suspected', 'probable', 'confirmed']).default('confirmed'),
    onsetDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'onsetDate must be YYYY-MM-DD')
      .nullish(),
  })
  .refine((v) => (v.code ?? null) === null === ((v.codeSystem ?? null) === null), {
    message: 'code and codeSystem must be supplied together',
    path: ['code'],
  });

export const DiagnosisPatchSchema = z
  .object({
    description: z.string().trim().min(2).max(500).optional(),
    category: z.enum(['primary', 'secondary', 'differential']).optional(),
    certainty: z.enum(['suspected', 'probable', 'confirmed']).optional(),
    status: z.enum(['active', 'resolved', 'ruled_out']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No diagnosis fields supplied' });

export const NoteSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  noteType: z
    .enum(['progress', 'examination', 'assessment', 'plan', 'correction', 'handover'])
    .default('progress'),
  supersedesId: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/**
 * Clinical writes are only accepted on an open consultation that the writing
 * doctor holds. A second doctor must explicitly take the encounter over
 * (`startConsultation`), which is audited — so two clinicians can never edit
 * one consultation record without a trace of the handover.
 */
async function lockOpenConsultation(
  client: PoolClient,
  principal: Principal,
  encounterId: string,
): Promise<{ encounter: Encounter; clinical: EncounterClinical }> {
  const encounter = await lockEncounter(client, principal.clinicId, encounterId);
  if (TERMINAL_STATUSES.includes(encounter.status)) {
    throw new ConflictError(`Encounter is ${encounter.status}; the clinical record is closed`);
  }
  if (encounter.status !== 'in_progress') {
    throw new ConflictError(
      'The consultation has not been started; call POST /encounters/:id/start first',
      { status: encounter.status },
    );
  }
  const clinical = await ensureEncounterClinical(
    client,
    principal.clinicId,
    encounter.id,
    encounter.patientId,
    principal.userId,
  );
  if (clinical.attendingDoctorId && clinical.attendingDoctorId !== principal.userId) {
    throw new ForbiddenError(
      'This consultation is held by another clinician; take it over before writing to it',
    );
  }
  return { encounter, clinical };
}

// ---------------------------------------------------------------------------
// Consultation lifecycle
// ---------------------------------------------------------------------------

/**
 * Take the patient: move `ready → in_progress` and record the attending doctor.
 * Called again by a different doctor it performs an audited handover instead.
 */
export async function startConsultation(
  principal: Principal,
  encounterId: string,
): Promise<{ encounter: Encounter; clinical: EncounterClinical }> {
  requirePermission(principal, Permission.ENCOUNTER_CLINICAL_WRITE);

  return withTransaction(async (client) => {
    const encounter = await lockEncounter(client, principal.clinicId, encounterId);
    if (TERMINAL_STATUSES.includes(encounter.status)) {
      throw new ConflictError(`Encounter is ${encounter.status}; it cannot be started`);
    }

    const existing = await ensureEncounterClinical(
      client,
      principal.clinicId,
      encounter.id,
      encounter.patientId,
      principal.userId,
    );
    const isHandover =
      encounter.status === 'in_progress' &&
      !!existing.attendingDoctorId &&
      existing.attendingDoctorId !== principal.userId;

    let current = encounter;
    if (encounter.status !== 'in_progress') {
      current = await applyStatusTx(client, principal, encounter, 'in_progress', 'staff_decision');
    }

    const clinical = await attachDoctorTx(client, principal, current, {
      isHandover,
      previousDoctorId: existing.attendingDoctorId,
    });

    return { encounter: current, clinical };
  });
}

/**
 * Record the attending doctor on an in-progress encounter and journal it.
 * Shared by `startConsultation` and by "Save & Next" (C003), so both paths
 * produce the same clinical record, event and audit trail.
 */
export async function attachDoctorTx(
  client: PoolClient,
  principal: Principal,
  encounter: Encounter,
  opts: { isHandover?: boolean; previousDoctorId?: string | null } = {},
): Promise<EncounterClinical> {
  const isHandover = opts.isHandover ?? false;
  await ensureEncounterClinical(
    client,
    principal.clinicId,
    encounter.id,
    encounter.patientId,
    principal.userId,
  );
  const clinical = await markStarted(
    client,
    principal.clinicId,
    encounter.id,
    principal.userId,
  );

  // A linked appointment follows the encounter into consultation.
  await syncAppointmentFromEncounterTx(client, principal, encounter.id, 'in_consultation');

  await emitEvent(client, {
    clinicId: principal.clinicId,
    type: EventType.ENCOUNTER_STARTED,
    subjectType: 'encounter',
    subjectId: encounter.id,
    actorId: principal.userId,
    payload: { patientId: encounter.patientId, handover: isHandover },
  });
  await auditTx(client, {
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: isHandover ? 'encounter.takeover' : 'encounter.start',
    outcome: 'success',
    targetType: 'encounter',
    targetId: encounter.id,
    metadata: {
      patientId: encounter.patientId,
      ...(isHandover ? { previousDoctorId: opts.previousDoctorId ?? null } : {}),
    },
  });

  return clinical;
}

/**
 * Close the consultation. Doctor-only (`encounter:complete`), and refused
 * unless the record carries clinical content — a completed visit with neither
 * an assessment nor a diagnosis is a hole in the patient's history, not a
 * finished consultation.
 */
export async function completeEncounter(
  principal: Principal,
  encounterId: string,
): Promise<Encounter> {
  requirePermission(principal, Permission.ENCOUNTER_COMPLETE);
  return withTransaction((client) => completeEncounterTx(client, principal, encounterId));
}

/**
 * Transaction-scoped completion. "Save & Next" (C003) calls this so closing one
 * consultation and claiming the next patient commit as a single unit. The
 * caller asserts `encounter:complete` before entering the transaction.
 */
export async function completeEncounterTx(
  client: PoolClient,
  principal: Principal,
  encounterId: string,
): Promise<Encounter> {
  const encounter = await lockEncounter(client, principal.clinicId, encounterId);
  if (encounter.status !== 'in_progress') {
    throw new ConflictError(
      `Only an in-progress consultation can be completed (encounter is ${encounter.status})`,
    );
  }

  const [assessment, diagnoses] = await Promise.all([
    getAssessment(principal.clinicId, encounter.id, client),
    listDiagnoses(principal.clinicId, encounter.id, client),
  ]);
  if (!assessment && diagnoses.length === 0) {
    throw new ConflictError(
      'Record an assessment or a diagnosis before completing the consultation',
    );
  }

  const updated = await applyStatusTx(client, principal, encounter, 'completed');
  await markCompleted(client, principal.clinicId, encounter.id, principal.userId);
  await syncAppointmentFromEncounterTx(client, principal, encounter.id, 'completed');

  await emitEvent(client, {
    clinicId: principal.clinicId,
    type: EventType.ENCOUNTER_COMPLETED,
    subjectType: 'encounter',
    subjectId: encounter.id,
    actorId: principal.userId,
    payload: {
      patientId: encounter.patientId,
      diagnosisCount: diagnoses.length,
      hasAssessment: !!assessment,
    },
  });
  await auditTx(client, {
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'encounter.complete',
    outcome: 'success',
    targetType: 'encounter',
    targetId: encounter.id,
    metadata: { patientId: encounter.patientId, diagnosisCount: diagnoses.length },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Clinical content
// ---------------------------------------------------------------------------
export interface ClinicalPatchResult {
  clinical: EncounterClinical;
  assessment: Assessment | null;
  treatmentPlan: TreatmentPlan | null;
}

export async function updateClinical(
  principal: Principal,
  encounterId: string,
  raw: unknown,
): Promise<ClinicalPatchResult> {
  requirePermission(principal, Permission.ENCOUNTER_CLINICAL_WRITE);

  const parsed = ClinicalPatchSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid clinical update', parsed.error.flatten());
  }
  const patch = parsed.data;

  // A treatment plan is a separate clinical authority from the narrative.
  if (patch.treatmentPlan) requirePermission(principal, Permission.TREATMENT_WRITE);

  return withTransaction(async (client) => {
    const { encounter } = await lockOpenConsultation(client, principal, encounterId);

    const fieldPatch: { complaint?: string | null; examination?: string | null } = {};
    if ('complaint' in patch) fieldPatch.complaint = patch.complaint ?? null;
    if ('examination' in patch) fieldPatch.examination = patch.examination ?? null;

    const clinical =
      Object.keys(fieldPatch).length > 0
        ? await updateEncounterClinical(
            client,
            principal.clinicId,
            encounter.id,
            fieldPatch,
            principal.userId,
          )
        : (await getEncounterClinical(principal.clinicId, encounter.id, client))!;

    let assessment: Assessment | null = null;
    if (patch.assessment) {
      assessment = await upsertAssessment(client, {
        clinicId: principal.clinicId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
        summary: patch.assessment.summary,
        severity: patch.assessment.severity ?? null,
        recordedBy: principal.userId,
      });
    } else {
      assessment = await getAssessment(principal.clinicId, encounter.id, client);
    }

    let treatmentPlan: TreatmentPlan | null = null;
    if (patch.treatmentPlan) {
      treatmentPlan = await upsertTreatmentPlan(client, {
        clinicId: principal.clinicId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
        summary: patch.treatmentPlan.summary,
        instructions: patch.treatmentPlan.instructions ?? null,
        followUpInDays: patch.treatmentPlan.followUpInDays ?? null,
        recordedBy: principal.userId,
      });
      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.TREATMENT_PLAN_RECORDED,
        subjectType: 'encounter',
        subjectId: encounter.id,
        actorId: principal.userId,
        payload: {
          patientId: encounter.patientId,
          treatmentPlanId: treatmentPlan.id,
          followUpInDays: treatmentPlan.followUpInDays,
        },
      });
    } else {
      treatmentPlan = await getTreatmentPlan(principal.clinicId, encounter.id, client);
    }

    // Which sections changed — never their content.
    const sections = Object.keys(patch);
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.ENCOUNTER_CLINICAL_UPDATED,
      subjectType: 'encounter',
      subjectId: encounter.id,
      actorId: principal.userId,
      payload: { patientId: encounter.patientId, sections },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'encounter.clinical.update',
      outcome: 'success',
      targetType: 'encounter',
      targetId: encounter.id,
      metadata: { patientId: encounter.patientId, sections },
    });

    return { clinical, assessment, treatmentPlan };
  });
}

export async function addDiagnosis(
  principal: Principal,
  encounterId: string,
  raw: unknown,
): Promise<Diagnosis> {
  requirePermission(principal, Permission.DIAGNOSIS_WRITE);

  const parsed = DiagnosisSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid diagnosis', parsed.error.flatten());
  }
  const input = parsed.data;

  return withTransaction(async (client) => {
    const { encounter } = await lockOpenConsultation(client, principal, encounterId);

    let diagnosis: Diagnosis;
    try {
      diagnosis = await insertDiagnosis(client, {
        clinicId: principal.clinicId,
        encounterId: encounter.id,
        patientId: encounter.patientId,
        description: input.description,
        codeSystem: input.codeSystem ?? null,
        code: input.code ?? null,
        category: input.category,
        certainty: input.certainty,
        onsetDate: input.onsetDate ?? null,
        recordedBy: principal.userId,
      });
    } catch (err) {
      if (isUniqueViolation(err, 'uq_diagnosis_primary')) {
        throw new ConflictError(
          'This encounter already has a primary diagnosis; revise it or record this one as secondary',
        );
      }
      throw err;
    }

    // Diagnosis coding is a controlled vocabulary, not PHI, so it is safe in
    // the audit trail; the free-text description is not and stays out.
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.DIAGNOSIS_RECORDED,
      subjectType: 'encounter',
      subjectId: encounter.id,
      actorId: principal.userId,
      payload: {
        patientId: encounter.patientId,
        diagnosisId: diagnosis.id,
        category: diagnosis.category,
        certainty: diagnosis.certainty,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'diagnosis.record',
      outcome: 'success',
      targetType: 'diagnosis',
      targetId: diagnosis.id,
      metadata: {
        patientId: encounter.patientId,
        encounterId: encounter.id,
        category: diagnosis.category,
        certainty: diagnosis.certainty,
      },
    });

    return diagnosis;
  });
}

export async function reviseDiagnosis(
  principal: Principal,
  encounterId: string,
  diagnosisId: string,
  raw: unknown,
): Promise<Diagnosis> {
  requirePermission(principal, Permission.DIAGNOSIS_WRITE);

  const parsed = DiagnosisPatchSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid diagnosis revision', parsed.error.flatten());
  }
  const patch = parsed.data;

  return withTransaction(async (client) => {
    const { encounter } = await lockOpenConsultation(client, principal, encounterId);
    const existing = await findDiagnosis(client, principal.clinicId, diagnosisId);
    if (!existing || existing.encounterId !== encounter.id) throw new NotFoundError('Diagnosis');

    let updated: Diagnosis;
    try {
      updated = await updateDiagnosis(
        client,
        principal.clinicId,
        diagnosisId,
        patch,
        principal.userId,
      );
    } catch (err) {
      if (isUniqueViolation(err, 'uq_diagnosis_primary')) {
        throw new ConflictError('This encounter already has a primary diagnosis');
      }
      throw err;
    }

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.DIAGNOSIS_REVISED,
      subjectType: 'encounter',
      subjectId: encounter.id,
      actorId: principal.userId,
      payload: {
        patientId: encounter.patientId,
        diagnosisId: updated.id,
        fields: Object.keys(patch),
      },
    });
    // A changed diagnosis is a high-value clinical event: record the
    // before/after of the CODED fields so a reviewer can reconstruct it.
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'diagnosis.revise',
      outcome: 'success',
      targetType: 'diagnosis',
      targetId: updated.id,
      metadata: {
        patientId: encounter.patientId,
        encounterId: encounter.id,
        fields: Object.keys(patch),
        from: { category: existing.category, certainty: existing.certainty, status: existing.status },
        to: { category: updated.category, certainty: updated.certainty, status: updated.status },
      },
    });

    return updated;
  });
}

export async function addNote(
  principal: Principal,
  encounterId: string,
  raw: unknown,
): Promise<ClinicalNote> {
  requirePermission(principal, Permission.NOTE_WRITE);

  const parsed = NoteSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid note', parsed.error.flatten());
  const input = parsed.data;
  if (input.supersedesId && input.noteType !== 'correction') {
    throw new ValidationError('Only a correction note may supersede another note');
  }

  return withTransaction(async (client) => {
    const { encounter } = await lockOpenConsultation(client, principal, encounterId);

    if (input.supersedesId) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM clinical_note WHERE id = $1 AND clinic_id = $2 AND encounter_id = $3`,
        [input.supersedesId, principal.clinicId, encounter.id],
      );
      if (!rows[0]) throw new NotFoundError('Superseded note');
    }

    const note = await insertNote(client, {
      clinicId: principal.clinicId,
      encounterId: encounter.id,
      patientId: encounter.patientId,
      noteType: input.noteType,
      body: input.body,
      supersedesId: input.supersedesId ?? null,
      authorId: principal.userId,
    });

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.CLINICAL_NOTE_ADDED,
      subjectType: 'encounter',
      subjectId: encounter.id,
      actorId: principal.userId,
      payload: { patientId: encounter.patientId, noteId: note.id, noteType: note.noteType },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'clinical_note.add',
      outcome: 'success',
      targetType: 'clinical_note',
      targetId: note.id,
      metadata: { patientId: encounter.patientId, encounterId: encounter.id, noteType: note.noteType },
    });

    return note;
  });
}

// ---------------------------------------------------------------------------
// Read: the doctor workspace
// ---------------------------------------------------------------------------
export interface PreviousVisit {
  encounterId: string;
  checkedInAt: string;
  completedAt: string | null;
  primaryDiagnosis: string | null;
}

export interface EncounterWorkspace {
  encounter: Encounter;
  patient: { id: string; mrn: string; fullName: string; sex: string; birthDate: string | null };
  intake?: Intake | null;
  vitals?: Vital[];
  clinical?: EncounterClinical | null;
  assessment?: Assessment | null;
  diagnoses?: Diagnosis[];
  treatmentPlan?: TreatmentPlan | null;
  notes?: ClinicalNote[];
  prescriptions?: Prescription[];
  followUps?: FollowUp[];
  previousVisits?: PreviousVisit[];
}

/**
 * The full consultation view. Sections are assembled per-permission: a caller
 * holding only `encounter:read` sees the encounter and patient header, and the
 * clinical sections are omitted entirely rather than returned empty — so the
 * response never implies a caller was allowed to see clinical data.
 */
export async function getWorkspace(
  principal: Principal,
  encounterId: string,
): Promise<EncounterWorkspace> {
  requirePermission(principal, Permission.ENCOUNTER_READ);

  const encounter = await getEncounterOrThrow(principal.clinicId, encounterId);
  const patient = await getPatientById(principal.clinicId, encounter.patientId);
  if (!patient) throw new NotFoundError('Patient');

  const workspace: EncounterWorkspace = {
    encounter,
    patient: {
      id: patient.id,
      mrn: patient.mrn,
      fullName: patient.fullName,
      sex: patient.sex,
      birthDate: patient.birthDate,
    },
  };

  if (hasPermission(principal, Permission.INTAKE_READ)) {
    workspace.intake = await getIntakeByEncounter(principal.clinicId, encounter.id);
  }
  if (hasPermission(principal, Permission.VITALS_READ)) {
    workspace.vitals = await listVitalsByEncounter(principal.clinicId, encounter.id);
  }
  if (hasPermission(principal, Permission.PRESCRIPTION_READ)) {
    workspace.prescriptions = await listEncounterPrescriptions(principal.clinicId, encounter.id);
  }
  if (hasPermission(principal, Permission.FOLLOWUP_READ)) {
    workspace.followUps = await listFollowUpsByEncounter(principal.clinicId, encounter.id);
  }
  if (hasPermission(principal, Permission.ENCOUNTER_CLINICAL_READ)) {
    const [clinical, assessment, diagnoses, treatmentPlan, notes, previousVisits] =
      await Promise.all([
        getEncounterClinical(principal.clinicId, encounter.id),
        getAssessment(principal.clinicId, encounter.id),
        listDiagnoses(principal.clinicId, encounter.id),
        getTreatmentPlan(principal.clinicId, encounter.id),
        listNotes(principal.clinicId, encounter.id),
        listPreviousVisits(principal.clinicId, encounter.patientId, encounter.id),
      ]);
    Object.assign(workspace, {
      clinical,
      assessment,
      diagnoses,
      treatmentPlan,
      notes,
      previousVisits,
    });
  }

  return workspace;
}

/** Recent completed visits for the same patient, newest first (§4.3 context). */
export async function listPreviousVisits(
  clinicId: string,
  patientId: string,
  excludeEncounterId: string | null,
  limit = 5,
): Promise<PreviousVisit[]> {
  const { rows } = await getPool().query<{
    id: string;
    checked_in_at: string;
    completed_at: string | null;
    primary_diagnosis: string | null;
  }>(
    `SELECT e.id,
            e.checked_in_at,
            ec.completed_at,
            (SELECT d.description FROM diagnosis d
              WHERE d.encounter_id = e.id AND d.category = 'primary'
              LIMIT 1) AS primary_diagnosis
       FROM encounter e
       LEFT JOIN encounter_clinical ec ON ec.encounter_id = e.id
      WHERE e.clinic_id = $1
        AND e.patient_id = $2
        AND e.status = 'completed'
        AND ($3::uuid IS NULL OR e.id <> $3)
      ORDER BY e.checked_in_at DESC
      LIMIT $4`,
    [clinicId, patientId, excludeEncounterId, limit],
  );
  return rows.map((r) => ({
    encounterId: r.id,
    checkedInAt: r.checked_in_at,
    completedAt: r.completed_at,
    primaryDiagnosis: r.primary_diagnosis,
  }));
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505' &&
    (err as { constraint?: string }).constraint === constraint
  );
}
