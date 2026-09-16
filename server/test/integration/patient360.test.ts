import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

let app: FastifyInstance;
let clinicId: string;
let reception: TestUser;
let nurse: TestUser;
let doctor: TestUser;
let admin: TestUser;

const bearer = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

beforeEach(async () => {
  await resetDb();
  ({ clinicId } = await makeClinic());
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  nurse = await makeUser(clinicId, 'nurse', RoleKey.NURSE);
  doctor = await makeUser(clinicId, 'doctor', RoleKey.DOCTOR);
  admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

/** Build a patient with a rich clinical footprint across many phases. */
async function richPatient(): Promise<{ patientId: string }> {
  const patient = (
    await app.inject({
      method: 'POST',
      url: '/patients',
      headers: bearer(reception),
      payload: { fullName: 'Three Sixty', sex: 'female', birthDate: '1985-06-15' },
    })
  ).json();

  await app.inject({
    method: 'POST',
    url: `/patients/${patient.id}/allergies`,
    headers: bearer(nurse),
    payload: { substance: 'Penicillin', severity: 'severe' },
  });
  await app.inject({
    method: 'POST',
    url: `/patients/${patient.id}/contacts`,
    headers: bearer(reception),
    payload: { fullName: 'Kin Person', phone: '+201000000001' },
  });
  await app.inject({
    method: 'POST',
    url: `/documents`,
    headers: bearer(reception),
    payload: {
      patientId: patient.id,
      docType: 'referral',
      title: 'Referral letter',
      contentType: 'application/pdf',
      storageKey: `s3://b/${patient.id}`,
    },
  });

  // A completed visit with a diagnosis and an active prescription.
  const encounter = (
    await app.inject({
      method: 'POST',
      url: '/encounters/check-in',
      headers: bearer(reception),
      payload: { patientId: patient.id },
    })
  ).json();
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounter.id}/intake`,
    headers: bearer(nurse),
    payload: { chiefComplaint: 'Sore throat' },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounter.id}/status`,
    headers: bearer(nurse),
    payload: { status: 'ready' },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounter.id}/start`,
    headers: bearer(doctor),
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounter.id}/prescriptions`,
    headers: bearer(doctor),
    payload: { items: [{ medicationName: 'Paracetamol', dose: '1g', route: 'oral', frequency: 'qds' }] },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounter.id}/diagnoses`,
    headers: bearer(doctor),
    payload: { description: 'Acute pharyngitis' },
  });
  await app.inject({
    method: 'POST',
    url: `/encounters/${encounter.id}/complete`,
    headers: bearer(doctor),
  });

  return { patientId: patient.id };
}

describe('Phase 16 — Patient 360', () => {
  it('assembles the full summary for a doctor', async () => {
    const { patientId } = await richPatient();
    const res = await app.inject({
      method: 'GET',
      url: `/patients/${patientId}/360`,
      headers: bearer(doctor),
    });
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v.patient.fullName).toBe('Three Sixty');
    expect(v.patient.birthDate).toBe('1985-06-15');
    expect(v.allergies).toHaveLength(1);
    expect(v.contacts).toHaveLength(1);
    expect(v.documents).toHaveLength(1);
    expect(v.activePrescriptions).toHaveLength(1);
    expect(v.recentVisits).toHaveLength(1);
    expect(v.recentVisits[0].primaryDiagnosis).toBe('Acute pharyngitis');
  });

  it('shapes the summary by permission — reception sees fewer sections', async () => {
    const { patientId } = await richPatient();
    const res = await app.inject({
      method: 'GET',
      url: `/patients/${patientId}/360`,
      headers: bearer(reception),
    });
    expect(res.statusCode).toBe(200);
    const v = res.json();
    // Reception has the operational sections plus allergies (a deliberate
    // front-desk safety grant from CP-8).
    expect(v.patient.mrn).toBeDefined();
    expect(v).toHaveProperty('contacts');
    expect(v).toHaveProperty('documents');
    expect(v).toHaveProperty('allergies');
    // But NOT the doctor/nurse-only clinical sections — omitted entirely,
    // not returned empty.
    expect(v).not.toHaveProperty('activePrescriptions');
    expect(v).not.toHaveProperty('recentObservations');
    expect(v).not.toHaveProperty('treatmentEpisodes');
  });

  it('gives a nurse the clinical read sections', async () => {
    const { patientId } = await richPatient();
    const v = (
      await app.inject({
        method: 'GET',
        url: `/patients/${patientId}/360`,
        headers: bearer(nurse),
      })
    ).json();
    expect(v).toHaveProperty('allergies');
    expect(v).toHaveProperty('activePrescriptions');
    expect(v.allergies).toHaveLength(1);
  });

  it('audits the read with the section names, and no PHI', async () => {
    const { patientId } = await richPatient();
    await app.inject({
      method: 'GET',
      url: `/patients/${patientId}/360`,
      headers: bearer(doctor),
    });
    const { rows } = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'patient.360.read'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.sections).toEqual(expect.arrayContaining(['allergies', 'documents']));
    expect(JSON.stringify(rows[0]!.metadata)).not.toMatch(/three sixty|penicillin|pharyngitis/i);
  });

  it('flags a merged record so the caller can redirect', async () => {
    const survivor = (
      await app.inject({
        method: 'POST',
        url: '/patients',
        headers: bearer(reception),
        payload: { fullName: 'Survivor', sex: 'male' },
      })
    ).json();
    const duplicate = (
      await app.inject({
        method: 'POST',
        url: '/patients',
        headers: bearer(reception),
        payload: { fullName: 'Duplicate', sex: 'male' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/patients/${survivor.id}/merge`,
      headers: bearer(admin),
      payload: { sourcePatientId: duplicate.id, reason: 'Duplicate registration' },
    });

    const v = (
      await app.inject({
        method: 'GET',
        url: `/patients/${duplicate.id}/360`,
        headers: bearer(doctor),
      })
    ).json();
    expect(v.patient.status).toBe('merged');
    expect(v.patient.mergedIntoId).toBe(survivor.id);
  });

  it('denies the summary to a pharma rep and is clinic-scoped', async () => {
    const { patientId } = await richPatient();
    const pharma = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
    expect(
      (await app.inject({ method: 'GET', url: `/patients/${patientId}/360`, headers: bearer(pharma) }))
        .statusCode,
    ).toBe(403);

    const other = await makeClinic('Other Clinic');
    const otherDoctor = await makeUser(other.clinicId, 'doc2', RoleKey.DOCTOR);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/patients/${patientId}/360`,
          headers: bearer(otherDoctor),
        })
      ).statusCode,
    ).toBe(404);
  });
});
