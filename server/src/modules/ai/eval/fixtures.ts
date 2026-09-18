import type { SourceRecord } from '../ai.types.js';

/**
 * Deterministic evaluation fixtures for the LocalAIProvider.
 *
 * SAFETY / PHI: every fixture below is entirely SYNTHETIC and PHI-FREE. There
 * are NO real patient names, ids, dates of birth, or any de-anonymisable
 * detail — only generic, made-up clinical phrasing (fever/cough/headache and
 * the like). These fixtures are therefore safe to version-control and store.
 *
 * Each intake `text` + `expected` pair is hand-verified against the actual
 * behaviour of `LocalAIProvider.extractIntake` (label: value parsing for the
 * recognised intake labels, plus an inline `for N <unit>` duration). Keep them
 * aligned to the real parser — the eval runner asserts full recall.
 */

/** One intake extraction case: input text and the field name→value map the local provider produces. */
export interface IntakeFixture {
  id: string;
  text: string;
  expected: Record<string, string>;
}

export const INTAKE_FIXTURES: IntakeFixture[] = [
  {
    // Two explicit labelled lines.
    id: 'intake-labelled-basic',
    text: 'Chief complaint: fever\nDuration: 3 days',
    expected: { chiefComplaint: 'fever', duration: '3 days' },
  },
  {
    // Multiple recognised labels, including allergies + medications.
    id: 'intake-allergies-meds',
    text: 'Chief complaint: cough\nAllergies: penicillin\nMedications: ibuprofen',
    expected: { chiefComplaint: 'cough', allergies: 'penicillin', medications: 'ibuprofen' },
  },
  {
    // No label lines at all — only the inline "for N days" duration is picked up.
    id: 'intake-inline-duration-only',
    text: 'Patient reports headache for 5 days',
    expected: { duration: '5 days' },
  },
  {
    // Labelled history whose text ALSO carries an inline duration, so the parser
    // emits chiefComplaint + history + an inferred duration field.
    id: 'intake-history-with-inline-duration',
    text: 'Complaint: sore throat\nHistory: mild fever for 2 days',
    expected: { chiefComplaint: 'sore throat', history: 'mild fever for 2 days', duration: '2 days' },
  },
  {
    // Explicit duration in weeks plus a "none" medication value.
    id: 'intake-weeks-and-none-meds',
    text: 'Chief complaint: nausea\nDuration: 1 week\nMedications: none',
    expected: { chiefComplaint: 'nausea', duration: '1 week', medications: 'none' },
  },
];

/** One summarisation case: synthetic sources plus the minimum grounded citation count expected. */
export interface SummaryFixture {
  id: string;
  sources: SourceRecord[];
  expectMinCitations: number;
}

export const SUMMARY_FIXTURES: SummaryFixture[] = [
  {
    id: 'summary-single-source',
    sources: [
      { ref: 'evt-a1', kind: 'event', text: 'Reported fever and mild cough.', occurredAt: '2020-01-01T09:00:00Z' },
    ],
    expectMinCitations: 1,
  },
  {
    id: 'summary-two-sources',
    sources: [
      { ref: 'evt-b1', kind: 'event', text: 'Headache noted at triage.', occurredAt: '2020-02-01T10:00:00Z' },
      { ref: 'enc-b2', kind: 'encounter', text: 'Follow-up: headache resolved.', occurredAt: '2020-02-08T10:00:00Z' },
    ],
    expectMinCitations: 2,
  },
  {
    id: 'summary-three-sources',
    sources: [
      { ref: 'evt-c1', kind: 'event', text: 'Sore throat reported.', occurredAt: '2020-03-01T08:00:00Z' },
      { ref: 'evt-c2', kind: 'event', text: 'Prescribed rest and fluids.', occurredAt: '2020-03-02T08:00:00Z' },
      { ref: 'enc-c3', kind: 'encounter', text: 'Symptoms improving.', occurredAt: '2020-03-05T08:00:00Z' },
    ],
    expectMinCitations: 3,
  },
  {
    id: 'summary-unordered-sources',
    sources: [
      { ref: 'enc-d2', kind: 'encounter', text: 'Nausea subsided.', occurredAt: '2020-04-10T12:00:00Z' },
      { ref: 'evt-d1', kind: 'event', text: 'Nausea and fatigue reported.', occurredAt: '2020-04-03T12:00:00Z' },
    ],
    expectMinCitations: 2,
  },
];
