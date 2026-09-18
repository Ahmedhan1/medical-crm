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

const bearer = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const SHA = 'a'.repeat(64);

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

async function newPatient(name = 'Document Patient', user: TestUser = reception) {
  return (
    await app.inject({
      method: 'POST',
      url: '/patients',
      headers: bearer(user),
      payload: { fullName: name, sex: 'female' },
    })
  ).json();
}

async function register(payload: Record<string, unknown>, user: TestUser = reception) {
  return app.inject({ method: 'POST', url: '/documents', headers: bearer(user), payload });
}

const LAB = (patientId: string, over: Record<string, unknown> = {}) => ({
  patientId,
  docType: 'lab_report',
  title: 'CBC result',
  contentType: 'application/pdf',
  storageKey: `s3://bucket/${Math.random().toString(36).slice(2)}`,
  ...over,
});

describe('Phase 9 — document references', () => {
  it('registers a document reference with integrity metadata', async () => {
    const patient = await newPatient();
    const res = await register(
      LAB(patient.id, { sizeBytes: 20480, checksumSha256: SHA }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().docType).toBe('lab_report');
    expect(res.json().status).toBe('current');
    expect(res.json().checksumSha256).toBe(SHA);
    // The bytes are never stored: only a pointer.
    expect(res.json().storageKey).toMatch(/^s3:/);
  });

  it('rejects a malformed MIME type and checksum', async () => {
    const patient = await newPatient();
    expect((await register(LAB(patient.id, { contentType: 'not a mime' }))).statusCode).toBe(400);
    expect((await register(LAB(patient.id, { checksumSha256: 'xyz' }))).statusCode).toBe(400);
  });

  it('links a document to an encounter and validates ownership', async () => {
    const patient = await newPatient();
    const other = await newPatient('Other Patient');
    const encounter = (
      await app.inject({
        method: 'POST',
        url: '/encounters/check-in',
        headers: bearer(reception),
        payload: { patientId: patient.id },
      })
    ).json();

    expect((await register(LAB(patient.id, { encounterId: encounter.id }))).statusCode).toBe(201);
    // Encounter belongs to a different patient.
    expect((await register(LAB(other.id, { encounterId: encounter.id }))).statusCode).toBe(400);
  });

  it('versions a document by superseding the previous one', async () => {
    const patient = await newPatient();
    const first = (await register(LAB(patient.id, { title: 'Draft report' }))).json();
    const second = await register(
      LAB(patient.id, { title: 'Final report', supersedesId: first.id }),
    );
    expect(second.statusCode).toBe(201);
    expect(second.json().supersedesId).toBe(first.id);

    // The old version is superseded, not deleted; default list shows only current.
    const list = await app.inject({
      method: 'GET',
      url: `/patients/${patient.id}/documents`,
      headers: bearer(doctor),
    });
    expect(list.json().documents).toHaveLength(1);
    expect(list.json().documents[0].title).toBe('Final report');

    const withHistory = await app.inject({
      method: 'GET',
      url: `/patients/${patient.id}/documents?includeSuperseded=true`,
      headers: bearer(doctor),
    });
    expect(withHistory.json().documents).toHaveLength(2);
  });

  it('refuses to supersede an already-superseded document', async () => {
    const patient = await newPatient();
    const first = (await register(LAB(patient.id))).json();
    await register(LAB(patient.id, { supersedesId: first.id }));
    const third = await register(LAB(patient.id, { supersedesId: first.id }));
    expect(third.statusCode).toBe(409);
  });

  it('refuses to register the same storage object twice', async () => {
    const patient = await newPatient();
    const key = 's3://bucket/unique-object';
    expect((await register(LAB(patient.id, { storageKey: key }))).statusCode).toBe(201);
    expect((await register(LAB(patient.id, { storageKey: key }))).statusCode).toBe(409);
  });

  it('voids a document but keeps it out of the default list', async () => {
    const patient = await newPatient();
    const doc = (await register(LAB(patient.id))).json();
    const voided = await app.inject({
      method: 'POST',
      url: `/documents/${doc.id}/void`,
      headers: bearer(doctor),
      payload: { reason: 'Attached to the wrong patient' },
    });
    expect(voided.statusCode).toBe(200);
    expect(voided.json().status).toBe('entered_in_error');

    const list = await app.inject({
      method: 'GET',
      url: `/patients/${patient.id}/documents`,
      headers: bearer(doctor),
    });
    expect(list.json().documents).toHaveLength(0);
  });

  it('lets only a document manager void', async () => {
    const patient = await newPatient();
    const doc = (await register(LAB(patient.id))).json();
    for (const user of [reception, nurse]) {
      const res = await app.inject({
        method: 'POST',
        url: `/documents/${doc.id}/void`,
        headers: bearer(user),
        payload: { reason: 'x reason' },
      });
      expect(res.statusCode).toBe(403);
    }
  });
});

describe('Phase 9 — access policy', () => {
  it('hides a restricted document from a reader without the grant', async () => {
    const patient = await newPatient();
    // Reception cannot even register a restricted document.
    expect(
      (await register(LAB(patient.id, { confidentiality: 'restricted' }), reception)).statusCode,
    ).toBe(403);
    // A nurse can.
    const doc = (
      await register(LAB(patient.id, { confidentiality: 'restricted', title: 'HIV result' }), nurse)
    ).json();

    // Reception lists documents but the restricted one is filtered out.
    const receptionList = await app.inject({
      method: 'GET',
      url: `/patients/${patient.id}/documents`,
      headers: bearer(reception),
    });
    expect(receptionList.json().documents).toHaveLength(0);

    // And a direct read is not-found (existence does not leak).
    const receptionRead = await app.inject({
      method: 'GET',
      url: `/documents/${doc.id}`,
      headers: bearer(reception),
    });
    expect(receptionRead.statusCode).toBe(404);

    // A doctor sees it.
    const doctorRead = await app.inject({
      method: 'GET',
      url: `/documents/${doc.id}`,
      headers: bearer(doctor),
    });
    expect(doctorRead.statusCode).toBe(200);
    expect(doctorRead.json().title).toBe('HIV result');
  });
});

describe('Phase 9 — integration and isolation', () => {
  it('shows documents on the timeline and redacts a restricted title', async () => {
    const patient = await newPatient();
    await register(LAB(patient.id, { title: 'Chest X-ray report', docType: 'imaging_report' }));
    await register(
      LAB(patient.id, { title: 'Genetic test result', confidentiality: 'restricted' }),
      nurse,
    );

    const timeline = await app.inject({
      method: 'GET',
      url: `/patients/${patient.id}/timeline`,
      headers: bearer(doctor),
    });
    const docs = timeline
      .json()
      .entries.filter((e: { kind: string }) => e.kind === 'document');
    expect(docs).toHaveLength(2);
    const normal = docs.find((d: { detail: { docType: string } }) => d.detail.docType === 'imaging_report');
    const restricted = docs.find((d: { detail: { confidentiality: string } }) => d.detail.confidentiality === 'restricted');
    expect(normal.summary).toBe('Chest X-ray report');
    // The restricted document is present but its title is redacted.
    expect(restricted.summary).toBeNull();
  });

  it('keeps the document title out of audit metadata and events', async () => {
    const patient = await newPatient();
    await register(LAB(patient.id, { title: 'Positive biopsy for carcinoma' }));
    const audit = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'document.register'`,
    );
    expect(JSON.stringify(audit.rows[0]!.metadata)).not.toMatch(/carcinoma/i);
    const events = await getPool().query<{ payload: unknown }>(
      `SELECT payload FROM event WHERE type = 'DOCUMENT_REGISTERED'`,
    );
    expect(JSON.stringify(events.rows[0]!.payload)).not.toMatch(/carcinoma/i);
  });

  it('carries a merged patient documents onto the survivor', async () => {
    const admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
    const survivor = await newPatient('Doc Survivor');
    const duplicate = await newPatient('Doc Duplicate');
    await register(LAB(duplicate.id, { title: 'From the duplicate' }));
    await app.inject({
      method: 'POST',
      url: `/patients/${survivor.id}/merge`,
      headers: bearer(admin),
      payload: { sourcePatientId: duplicate.id, reason: 'Duplicate registration' },
    });
    const list = await app.inject({
      method: 'GET',
      url: `/patients/${survivor.id}/documents`,
      headers: bearer(doctor),
    });
    expect(list.json().documents).toHaveLength(1);
    expect(list.json().documents[0].title).toBe('From the duplicate');
  });

  it('keeps documents inside the clinic boundary', async () => {
    const patient = await newPatient();
    const doc = (await register(LAB(patient.id))).json();
    const other = await makeClinic('Other Clinic');
    const otherDoctor = await makeUser(other.clinicId, 'doc2', RoleKey.DOCTOR);
    expect(
      (await app.inject({ method: 'GET', url: `/documents/${doc.id}`, headers: bearer(otherDoctor) }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/patients/${patient.id}/documents`,
          headers: bearer(otherDoctor),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('denies documents to a pharma rep', async () => {
    const patient = await newPatient();
    const doc = (await register(LAB(patient.id))).json();
    const pharma = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
    expect(
      (await app.inject({ method: 'GET', url: `/documents/${doc.id}`, headers: bearer(pharma) }))
        .statusCode,
    ).toBe(403);
  });
});
