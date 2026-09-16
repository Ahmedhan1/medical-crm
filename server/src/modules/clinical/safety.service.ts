import type { PoolClient } from '../../db/pool.js';
import { activeMedicationAllergies, type Allergy } from './allergies.service.js';

/**
 * The deterministic prescribing safety engine (Phase 8).
 *
 * The platform provides RULES; it never makes the clinical decision. These
 * checks are pure and explainable — no scoring, no model — and their output is
 * an advisory list the prescribing service acts on by refusing unless a
 * clinician explicitly, and auditably, overrides.
 *
 * The allergy match is name-based today because there is no coded drug↔allergen
 * cross-reference yet (that belongs to the drug master, Agent 4 — see the
 * CONTRACT_CHANGE_REQUEST). It is deliberately conservative: it errs toward
 * raising an alert (which a clinician can clear) rather than missing one.
 */

export type SafetyAlertType = 'allergy' | 'duplicate_medication';

export interface SafetyAlert {
  type: SafetyAlertType;
  /** The prescribed line that triggered the alert. */
  medicationName: string;
  /** For an allergy: the matched substance and its severity. */
  substance?: string;
  severity?: Allergy['severity'];
  allergyId?: string;
  /** For a duplicate: the existing active prescription line. */
  existingPrescriptionId?: string;
}

export interface PrescriptionLineInput {
  medicationName: string;
  medicationRef?: string | null;
}

/** Normalize a medication/substance name for comparison: lowercase, collapsed. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Token-aware containment: true when the shorter normalized name appears as a
 * whole-word run inside the longer. "penicillin" matches
 * "penicillin v potassium"; "pen" does not match "penicillin". This avoids the
 * substring false positives a naive `includes` would produce.
 */
function namesRelated(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  // Whole-word boundary match.
  const escaped = shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\W)${escaped}(\\W|$)`).test(longer);
}

/**
 * Match prescribed lines against a patient's active medication allergies.
 * A `medication_ref`/`substance_ref` exact match (once a shared code exists)
 * is treated as a definite match; otherwise the name heuristic applies.
 */
export function matchAllergies(
  lines: readonly PrescriptionLineInput[],
  allergies: readonly Allergy[],
): SafetyAlert[] {
  const alerts: SafetyAlert[] = [];
  for (const line of lines) {
    for (const allergy of allergies) {
      const refMatch =
        !!line.medicationRef &&
        !!allergy.substanceRef &&
        line.medicationRef === allergy.substanceRef;
      if (refMatch || namesRelated(line.medicationName, allergy.substance)) {
        alerts.push({
          type: 'allergy',
          medicationName: line.medicationName,
          substance: allergy.substance,
          severity: allergy.severity,
          allergyId: allergy.id,
        });
      }
    }
  }
  return alerts;
}

/**
 * Warn when a prescribed line repeats a medication the patient already has on an
 * ACTIVE prescription. Deterministic: same normalized medication name.
 */
export async function matchDuplicateMedications(
  client: Pick<PoolClient, 'query'>,
  clinicId: string,
  patientIds: string[],
  lines: readonly PrescriptionLineInput[],
): Promise<SafetyAlert[]> {
  const { rows } = await client.query<{ prescription_id: string; medication_name: string }>(
    `SELECT i.prescription_id, i.medication_name
       FROM prescription_item i
       JOIN prescription p ON p.id = i.prescription_id
      WHERE p.clinic_id = $1 AND p.patient_id = ANY($2::uuid[]) AND p.status = 'active'`,
    [clinicId, patientIds],
  );
  const alerts: SafetyAlert[] = [];
  for (const line of lines) {
    for (const existing of rows) {
      if (namesRelated(line.medicationName, existing.medication_name)) {
        alerts.push({
          type: 'duplicate_medication',
          medicationName: line.medicationName,
          existingPrescriptionId: existing.prescription_id,
        });
      }
    }
  }
  return alerts;
}

/**
 * Run every prescribing safety check for a patient (or their merged lineage)
 * against a set of prescribed lines, inside an existing transaction.
 */
export async function checkPrescriptionSafety(
  client: Pick<PoolClient, 'query'>,
  clinicId: string,
  patientIds: string[],
  lines: readonly PrescriptionLineInput[],
): Promise<SafetyAlert[]> {
  const allergies = await activeMedicationAllergies(client, clinicId, patientIds);
  const allergyAlerts = matchAllergies(lines, allergies);
  const duplicateAlerts = await matchDuplicateMedications(client, clinicId, patientIds, lines);
  return [...allergyAlerts, ...duplicateAlerts];
}
