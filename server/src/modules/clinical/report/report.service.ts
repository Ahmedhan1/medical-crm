import { getPool } from '../../../db/pool.js';
import { NotFoundError } from '../../../domain/errors.js';
import { emitEvent, EventType } from '../../../domain/events.js';
import { withTransaction } from '../../../db/pool.js';
import { auditTx } from '../../governance/audit.js';
import { Permission } from '../../governance/permissions.js';
import { requirePermission, type Principal } from '../../governance/rbac.js';
import { getPatientById, type Patient } from '../../identity/patients.repo.js';
import { getEncounterOrThrow } from '../encounter.repo.js';
import { getIntakeByEncounter } from '../intake.repo.js';
import { listVitalsByEncounter, type Vital } from '../vitals.repo.js';
import {
  getAssessment,
  getEncounterClinical,
  getTreatmentPlan,
  listDiagnoses,
  listNotes,
} from '../encounter.clinical.repo.js';
import { listPreviousVisits } from '../workspace.service.js';
import { listEncounterPrescriptions, type Prescription } from '../prescriptions.service.js';
import { listFollowUpsByEncounter } from '../followups.service.js';
import { renderPdf, type PdfBlock, type PdfDocument } from './pdf.js';

/**
 * The report engine (blueprint §31). Reports are assembled as a neutral
 * document model and only then rendered, so the same report can gain another
 * output format without touching how it is composed or authorized.
 *
 * Two invariants hold for every report:
 *   * The filename contains identifiers only — never a patient name, so a PDF
 *     sitting in a downloads folder or an email subject leaks nothing.
 *   * `generatedAt` is passed in rather than read from the clock, so a report is
 *     reproducible: the same data and stamp always produce the same bytes.
 */

export interface RenderedReport {
  /** Safe filename: identifiers only, no PHI. */
  filename: string;
  contentType: 'application/pdf';
  body: Buffer;
}

const dash = (v: string | number | null | undefined): string =>
  v === null || v === undefined || v === '' ? '—' : String(v);

const asDay = (value: string | Date | null): string =>
  value === null ? '—' : new Date(value).toISOString().slice(0, 10);

const asMinute = (value: string | Date | null): string =>
  value === null ? '—' : new Date(value).toISOString().slice(0, 16).replace('T', ' ');

function patientBlocks(patient: Patient): PdfBlock[] {
  return [
    { kind: 'heading', text: 'Patient' },
    { kind: 'field', label: 'Medical record no.', value: patient.mrn },
    { kind: 'field', label: 'Name', value: patient.fullName },
    { kind: 'field', label: 'Sex', value: patient.sex },
    { kind: 'field', label: 'Date of birth', value: dash(patient.birthDate) },
  ];
}

function vitalsLine(v: Vital): string {
  const parts: string[] = [];
  if (v.systolicBp !== null) parts.push(`BP ${v.systolicBp}/${v.diastolicBp} mmHg`);
  if (v.heartRate !== null) parts.push(`HR ${v.heartRate} bpm`);
  if (v.respiratoryRate !== null) parts.push(`RR ${v.respiratoryRate}/min`);
  if (v.temperatureC !== null) parts.push(`Temp ${v.temperatureC} C`);
  if (v.spo2 !== null) parts.push(`SpO2 ${v.spo2}%`);
  if (v.weightKg !== null) parts.push(`Weight ${v.weightKg} kg`);
  if (v.heightCm !== null) parts.push(`Height ${v.heightCm} cm`);
  if (v.bmi !== null) parts.push(`BMI ${v.bmi}`);
  if (v.bloodGlucoseMgdl !== null) parts.push(`Glucose ${v.bloodGlucoseMgdl} mg/dL`);
  if (v.painScore !== null) parts.push(`Pain ${v.painScore}/10`);
  return `${asMinute(v.recordedAt)} — ${parts.join(', ')}`;
}

/** One prescribed line, in the order a dispensing pharmacist reads it. */
function prescriptionLine(item: Prescription['items'][number]): string {
  const parts = [item.medicationName, item.dose, item.route, item.frequency];
  if (item.durationDays !== null) parts.push(`for ${item.durationDays} days`);
  if (item.quantity) parts.push(`qty ${item.quantity}`);
  const line = parts.join(' — ');
  return item.instructions ? `${line} (${item.instructions})` : line;
}

/** Build the encounter report's document model (no rendering, no I/O policy). */
export async function buildEncounterReport(
  clinicId: string,
  encounterId: string,
  generatedAt: string,
): Promise<PdfDocument> {
  const encounter = await getEncounterOrThrow(clinicId, encounterId);
  const patient = await getPatientById(clinicId, encounter.patientId);
  if (!patient) throw new NotFoundError('Patient');

  const [clinical, intake, vitals, assessment, diagnoses, plan, notes, prescriptions, followUps] =
    await Promise.all([
      getEncounterClinical(clinicId, encounter.id),
      getIntakeByEncounter(clinicId, encounter.id),
      listVitalsByEncounter(clinicId, encounter.id),
      getAssessment(clinicId, encounter.id),
      listDiagnoses(clinicId, encounter.id),
      getTreatmentPlan(clinicId, encounter.id),
      listNotes(clinicId, encounter.id),
      listEncounterPrescriptions(clinicId, encounter.id),
      listFollowUpsByEncounter(clinicId, encounter.id),
    ]);

  const blocks: PdfBlock[] = [
    { kind: 'title', text: 'Encounter Report' },
    { kind: 'rule' },
    ...patientBlocks(patient),
    { kind: 'heading', text: 'Visit' },
    { kind: 'field', label: 'Visit date', value: asMinute(encounter.checkedInAt) },
    { kind: 'field', label: 'Status', value: encounter.status },
    { kind: 'field', label: 'Completed', value: asMinute(clinical?.completedAt ?? null) },
  ];

  blocks.push({ kind: 'heading', text: 'Presenting complaint and history' });
  if (intake) {
    blocks.push({ kind: 'field', label: 'Chief complaint', value: intake.chiefComplaint });
    for (const [label, value] of [
      ['History of present illness', intake.historyPresentIllness],
      ['Past medical history', intake.pastMedicalHistory],
      ['Medication history', intake.medicationHistory],
      ['Allergies', intake.allergies],
      ['Family history', intake.familyHistory],
      ['Social history', intake.socialHistory],
    ] as const) {
      if (value) blocks.push({ kind: 'field', label, value });
    }
  } else {
    blocks.push({ kind: 'paragraph', text: 'No intake recorded for this visit.' });
  }

  blocks.push({ kind: 'heading', text: 'Vital signs' });
  if (vitals.length > 0) {
    // Oldest first reads as a chronology on paper.
    for (const v of [...vitals].reverse()) blocks.push({ kind: 'bullet', text: vitalsLine(v) });
  } else {
    blocks.push({ kind: 'paragraph', text: 'No vital signs recorded.' });
  }

  blocks.push({ kind: 'heading', text: 'Examination' });
  blocks.push({
    kind: 'paragraph',
    text: clinical?.examination || 'No examination findings recorded.',
  });

  blocks.push({ kind: 'heading', text: 'Assessment' });
  blocks.push({ kind: 'paragraph', text: assessment?.summary || 'No assessment recorded.' });
  if (assessment?.severity) {
    blocks.push({ kind: 'field', label: 'Severity', value: assessment.severity });
  }

  blocks.push({ kind: 'heading', text: 'Diagnoses' });
  if (diagnoses.length > 0) {
    for (const d of diagnoses) {
      const coded = d.code ? ` [${d.codeSystem} ${d.code}]` : '';
      blocks.push({
        kind: 'bullet',
        text: `${d.description}${coded} (${d.category}, ${d.certainty}, ${d.status})`,
      });
    }
  } else {
    blocks.push({ kind: 'paragraph', text: 'No diagnosis recorded.' });
  }

  blocks.push({ kind: 'heading', text: 'Treatment plan' });
  if (plan) {
    blocks.push({ kind: 'paragraph', text: plan.summary });
    if (plan.instructions) {
      blocks.push({ kind: 'field', label: 'Instructions', value: plan.instructions });
    }
    if (plan.followUpInDays !== null) {
      blocks.push({ kind: 'field', label: 'Follow up in', value: `${plan.followUpInDays} days` });
    }
  } else {
    blocks.push({ kind: 'paragraph', text: 'No treatment plan recorded.' });
  }

  blocks.push({ kind: 'heading', text: 'Prescriptions' });
  if (prescriptions.length > 0) {
    for (const p of prescriptions) {
      blocks.push({
        kind: 'field',
        label: `Issued ${asMinute(p.issuedAt)}`,
        value: p.status === 'cancelled' ? `CANCELLED — ${p.cancellationReason}` : 'Active',
      });
      for (const item of p.items) blocks.push({ kind: 'bullet', text: prescriptionLine(item) });
    }
  } else {
    blocks.push({ kind: 'paragraph', text: 'No prescription issued at this visit.' });
  }

  if (followUps.length > 0) {
    blocks.push({ kind: 'heading', text: 'Follow-up' });
    for (const f of followUps) {
      blocks.push({
        kind: 'bullet',
        text: `Due ${f.dueOn} (${f.status})${f.reason ? ` — ${f.reason}` : ''}`,
      });
    }
  }

  if (notes.length > 0) {
    blocks.push({ kind: 'heading', text: 'Clinical notes' });
    for (const n of notes) {
      blocks.push({ kind: 'bullet', text: `${asMinute(n.createdAt)} (${n.noteType}) ${n.body}` });
    }
  }

  return {
    title: `Encounter Report — MRN ${patient.mrn}`,
    footer: `Generated ${generatedAt}`,
    blocks,
  };
}

interface EpisodeSummaryRow {
  label: string;
  status: string;
  started_on: string | Date;
  ended_on: string | Date | null;
  latest_response: string | null;
}

/** Build the patient summary report's document model. */
export async function buildPatientReport(
  clinicId: string,
  patientId: string,
  generatedAt: string,
): Promise<PdfDocument> {
  const patient = await getPatientById(clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');

  const [visits, episodes] = await Promise.all([
    listPreviousVisits(clinicId, patient.id, null, 50),
    getPool().query<EpisodeSummaryRow>(
      `SELECT te.label, te.status, te.started_on, te.ended_on,
              (SELECT tr.response FROM treatment_response tr
                WHERE tr.episode_id = te.id
                ORDER BY tr.observed_on DESC, tr.created_at DESC LIMIT 1) AS latest_response
         FROM treatment_episode te
        WHERE te.clinic_id = $1 AND te.patient_id = $2
        ORDER BY te.started_on DESC
        LIMIT 50`,
      [clinicId, patient.id],
    ),
  ]);

  const blocks: PdfBlock[] = [
    { kind: 'title', text: 'Patient Summary' },
    { kind: 'rule' },
    ...patientBlocks(patient),
    { kind: 'heading', text: 'Completed visits' },
  ];

  if (visits.length > 0) {
    for (const v of visits) {
      blocks.push({
        kind: 'bullet',
        text: `${asMinute(v.checkedInAt)} — ${dash(v.primaryDiagnosis)}`,
      });
    }
  } else {
    blocks.push({ kind: 'paragraph', text: 'No completed visits on record.' });
  }

  blocks.push({ kind: 'heading', text: 'Treatment episodes' });
  if (episodes.rows.length > 0) {
    for (const e of episodes.rows) {
      const period = `${asDay(e.started_on)} to ${e.ended_on ? asDay(e.ended_on) : 'ongoing'}`;
      blocks.push({
        kind: 'bullet',
        text: `${e.label} (${period}; ${e.status}; response: ${dash(e.latest_response)})`,
      });
    }
  } else {
    blocks.push({ kind: 'paragraph', text: 'No treatment episodes on record.' });
  }

  return {
    title: `Patient Summary — MRN ${patient.mrn}`,
    footer: `Generated ${generatedAt}`,
    blocks,
  };
}

async function recordGeneration(
  principal: Principal,
  kind: 'encounter' | 'patient',
  subjectId: string,
  patientId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.CLINICAL_REPORT_GENERATED,
      subjectType: kind,
      subjectId,
      actorId: principal.userId,
      payload: { patientId, report: kind },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'report.generate',
      outcome: 'success',
      targetType: kind,
      targetId: subjectId,
      metadata: { patientId, report: kind },
    });
  });
}

export async function generateEncounterReport(
  principal: Principal,
  encounterId: string,
  generatedAt: string,
): Promise<RenderedReport> {
  requirePermission(principal, Permission.REPORT_GENERATE);

  const encounter = await getEncounterOrThrow(principal.clinicId, encounterId);
  const doc = await buildEncounterReport(principal.clinicId, encounter.id, generatedAt);
  await recordGeneration(principal, 'encounter', encounter.id, encounter.patientId);

  return {
    // Identifier only — a patient name in a filename is a PHI leak.
    filename: `encounter-${encounter.id}.pdf`,
    contentType: 'application/pdf',
    body: renderPdf(doc),
  };
}

export async function generatePatientReport(
  principal: Principal,
  patientId: string,
  generatedAt: string,
): Promise<RenderedReport> {
  requirePermission(principal, Permission.REPORT_GENERATE);

  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');

  const doc = await buildPatientReport(principal.clinicId, patient.id, generatedAt);
  await recordGeneration(principal, 'patient', patient.id, patient.id);

  return {
    filename: `patient-${patient.id}.pdf`,
    contentType: 'application/pdf',
    body: renderPdf(doc),
  };
}
