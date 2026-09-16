import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { authenticate } from '../../src/modules/auth/auth.service.js';
import {
  buildEncounterReport,
  generateEncounterReport,
} from '../../src/modules/clinical/report/report.service.js';
import { renderPdf } from '../../src/modules/clinical/report/pdf.js';

let app: FastifyInstance;
let clinicId: string;
let reception: TestUser;
let nurse: TestUser;
let doctor: TestUser;

const bearer = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

beforeEach(async () => {
  await resetDb();
  ({ clinicId } = await makeClinic());
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  nurse = await makeUser(clinicId, 'nurse', RoleKey.NURSE);
  doctor = await makeUser(clinicId, 'doctor', RoleKey.DOCTOR);
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

interface Visit {
  patientId: string;
  encounterId: string;
}

async function completedVisit(name = 'Report Patient'): Promise<Visit> {
  const patient = (
    await app.inject({
      method: 'POST',
      url: '/patients',
      headers: bearer(reception),
      payload: { fullName: name, sex: 'male', birthDate: '1980-04-02' },
    })
  ).json();
  const encounter = (
    await app.inject({
      method: 'POST',
      url: '/encounters/check-in',
      headers: bearer(reception),
      payload: { patientId: patient.id },
    })
  ).json();
  const id = encounter.id;

  await app.inject({
    method: 'POST',
    url: `/encounters/${id}/intake`,
    headers: bearer(nurse),
    payload: { chiefComplaint: 'Persistent cough', allergies: 'Penicillin' },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${id}/vitals`,
    headers: bearer(nurse),
    payload: { systolicBp: 128, diastolicBp: 82, heartRate: 74, temperatureC: 37.2 },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${id}/status`,
    headers: bearer(nurse),
    payload: { status: 'ready' },
  });
  await app.inject({ method: 'POST', url: `/encounters/${id}/start`, headers: bearer(doctor) });
  await app.inject({
    method: 'PATCH',
    url: `/encounters/${id}/clinical`,
    headers: bearer(doctor),
    payload: {
      examination: 'Chest clear on auscultation',
      assessment: { summary: 'Post-viral cough', severity: 'mild' },
      treatmentPlan: { summary: 'Supportive care', followUpInDays: 14 },
    },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${id}/diagnoses`,
    headers: bearer(doctor),
    payload: { description: 'Post-viral cough', codeSystem: 'ICD-10', code: 'R05' },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${id}/complete`,
    headers: bearer(doctor),
  });
  return { patientId: patient.id, encounterId: id };
}

describe('C006 — clinical reports', () => {
  it('renders an encounter report as a PDF containing the clinical record', async () => {
    const { encounterId } = await completedVisit();
    const res = await app.inject({
      method: 'GET',
      url: `/reports/encounter/${encounterId}.pdf`,
      headers: bearer(doctor),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const body = res.rawPayload;
    expect(body.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');

    const text = body.toString('latin1');
    expect(text).toContain('Encounter Report');
    expect(text).toContain('Persistent cough');
    expect(text).toContain('Chest clear on auscultation');
    expect(text).toContain('Post-viral cough');
    expect(text).toContain('ICD-10 R05');
    expect(text).toContain('BP 128/82 mmHg');
  });

  it('keeps the patient name out of the download filename', async () => {
    const { encounterId, patientId } = await completedVisit('Alice Wonderland');

    const encounterReport = await app.inject({
      method: 'GET',
      url: `/reports/encounter/${encounterId}.pdf`,
      headers: bearer(doctor),
    });
    const disposition = String(encounterReport.headers['content-disposition']);
    expect(disposition).toBe(`attachment; filename="encounter-${encounterId}.pdf"`);
    expect(disposition).not.toMatch(/alice|wonderland/i);

    const patientReport = await app.inject({
      method: 'GET',
      url: `/reports/patient/${patientId}.pdf`,
      headers: bearer(doctor),
    });
    expect(String(patientReport.headers['content-disposition'])).toBe(
      `attachment; filename="patient-${patientId}.pdf"`,
    );
  });

  it('renders identical bytes for the same data and the same stamp', async () => {
    const { encounterId } = await completedVisit();
    const first = renderPdf(await buildEncounterReport(clinicId, encounterId, 'STAMP'));
    const second = renderPdf(await buildEncounterReport(clinicId, encounterId, 'STAMP'));
    expect(first.equals(second)).toBe(true);
  });

  it('summarises visits and treatment episodes in the patient report', async () => {
    const { patientId } = await completedVisit('Summary Patient');
    const episode = await app.inject({
      method: 'POST',
      url: `/patients/${patientId}/treatment-episodes`,
      headers: bearer(doctor),
      payload: { label: 'Inhaled bronchodilator', startedOn: '2026-01-10' },
    });
    await app.inject({
      method: 'POST',
      url: `/treatment-episodes/${episode.json().id}/responses`,
      headers: bearer(doctor),
      payload: { observedOn: '2026-02-01', response: 'improved' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/reports/patient/${patientId}.pdf`,
      headers: bearer(doctor),
    });
    expect(res.statusCode).toBe(200);
    const text = res.rawPayload.toString('latin1');
    expect(text).toContain('Patient Summary');
    expect(text).toContain('Post-viral cough');
    expect(text).toContain('Inhaled bronchodilator');
    expect(text).toContain('response: improved');
  });

  it('renders a report for a visit with nothing recorded yet', async () => {
    const patient = (
      await app.inject({
        method: 'POST',
        url: '/patients',
        headers: bearer(reception),
        payload: { fullName: 'Empty Visit', sex: 'other' },
      })
    ).json();
    const encounter = (
      await app.inject({
        method: 'POST',
        url: '/encounters/check-in',
        headers: bearer(reception),
        payload: { patientId: patient.id },
      })
    ).json();

    const res = await app.inject({
      method: 'GET',
      url: `/reports/encounter/${encounter.id}.pdf`,
      headers: bearer(doctor),
    });
    expect(res.statusCode).toBe(200);
    const text = res.rawPayload.toString('latin1');
    expect(text).toContain('No intake recorded for this visit.');
    expect(text).toContain('No diagnosis recorded.');
  });

  it('denies reports to nurse and reception', async () => {
    const { encounterId, patientId } = await completedVisit();
    for (const user of [nurse, reception]) {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/reports/encounter/${encounterId}.pdf`,
            headers: bearer(user),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/reports/patient/${patientId}.pdf`,
            headers: bearer(user),
          })
        ).statusCode,
      ).toBe(403);
    }
  });

  it('requires authentication', async () => {
    const { encounterId } = await completedVisit();
    const res = await app.inject({
      method: 'GET',
      url: `/reports/encounter/${encounterId}.pdf`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('does not render a report for another clinic', async () => {
    const { encounterId } = await completedVisit();
    const other = await makeClinic('Other Clinic');
    const otherDoctor = await makeUser(other.clinicId, 'doc2', RoleKey.DOCTOR);
    const res = await app.inject({
      method: 'GET',
      url: `/reports/encounter/${encounterId}.pdf`,
      headers: bearer(otherDoctor),
    });
    expect(res.statusCode).toBe(404);
  });

  it('audits report generation without recording clinical content', async () => {
    const { encounterId } = await completedVisit('Audited Report Patient');
    await app.inject({
      method: 'GET',
      url: `/reports/encounter/${encounterId}.pdf`,
      headers: bearer(doctor),
    });

    const { rows } = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'report.generate'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.report).toBe('encounter');
    expect(JSON.stringify(rows[0]!.metadata)).not.toMatch(/cough|audited report patient/i);

    const events = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event WHERE type = 'CLINICAL_REPORT_GENERATED'`,
    );
    expect(Number(events.rows[0]!.n)).toBe(1);
  });

  it('asserts permission before touching the record', async () => {
    const { encounterId } = await completedVisit();
    const principal = await authenticate(nurse.token);
    await expect(
      generateEncounterReport(principal!, encounterId, 'STAMP'),
    ).rejects.toThrow(/permission/i);
  });
});
