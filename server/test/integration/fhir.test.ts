import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

/**
 * FHIR R4 REST interoperability tests. Proves the governed read API: resource +
 * search + $everything shapes, application/fhir+json, OperationOutcome errors,
 * the extra fhir:read gate (a clinician WITH clinical reads but WITHOUT fhir:read
 * is refused — the interop surface never widens access), and tenant isolation.
 */
let app: FastifyInstance;
let clinicId: string;
let admin: { token: string };
let doctor: { token: string };
let nurse: { token: string };
let patientId: string;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(async () => {
  await resetDb();
  ({ clinicId } = await makeClinic());
  admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
  doctor = await makeUser(clinicId, 'doctor', RoleKey.DOCTOR);
  nurse = await makeUser(clinicId, 'nurse', RoleKey.NURSE);
  app = buildServer();
  await app.ready();

  const patient = await app.inject({ method: 'POST', url: '/patients', headers: bearer(admin.token), payload: { fullName: 'Fhir Patient', sex: 'female', phone: '+201110000001' } });
  patientId = patient.json().id;
  await app.inject({ method: 'POST', url: `/patients/${patientId}/allergies`, headers: bearer(admin.token), payload: { substance: 'Penicillin', category: 'medication', severity: 'severe' } });
});
afterAll(async () => { if (app) await app.close(); });

describe('FHIR resource + search', () => {
  it('reads a Patient as application/fhir+json', async () => {
    const res = await app.inject({ method: 'GET', url: `/fhir/Patient/${patientId}`, headers: bearer(admin.token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/fhir+json');
    const body = res.json();
    expect(body.resourceType).toBe('Patient');
    expect(body.id).toBe(patientId);
    expect(body.name[0].text).toBe('Fhir Patient');
  });

  it('exposes a CapabilityStatement at /fhir/metadata', async () => {
    const res = await app.inject({ method: 'GET', url: '/fhir/metadata', headers: bearer(admin.token) });
    expect(res.json().resourceType).toBe('CapabilityStatement');
    expect(res.json().fhirVersion).toBe('4.0.1');
  });

  it('searches AllergyIntolerance by patient, returning a searchset Bundle', async () => {
    const res = await app.inject({ method: 'GET', url: `/fhir/AllergyIntolerance?patient=${patientId}`, headers: bearer(admin.token) });
    const body = res.json();
    expect(body.resourceType).toBe('Bundle');
    expect(body.type).toBe('searchset');
    expect(body.total).toBe(1);
    expect(body.entry[0].resource.resourceType).toBe('AllergyIntolerance');
    expect(body.entry[0].resource.code.text).toBe('Penicillin');
  });

  it('$everything returns a compartment Bundle including the allergy', async () => {
    const res = await app.inject({ method: 'GET', url: `/fhir/Patient/${patientId}/$everything`, headers: bearer(admin.token) });
    const body = res.json();
    expect(body.resourceType).toBe('Bundle');
    const types = body.entry.map((e: { resource: { resourceType: string } }) => e.resource.resourceType);
    expect(types).toContain('Patient');
    expect(types).toContain('AllergyIntolerance');
  });

  it('reads the clinic as an Organization', async () => {
    const res = await app.inject({ method: 'GET', url: `/fhir/Organization/${clinicId}`, headers: bearer(admin.token) });
    expect(res.json().resourceType).toBe('Organization');
    expect(res.json().id).toBe(clinicId);
  });

  it('a doctor (fhir:read + clinical reads) can read FHIR', async () => {
    const res = await app.inject({ method: 'GET', url: `/fhir/Patient/${patientId}`, headers: bearer(doctor.token) });
    expect(res.statusCode).toBe(200);
  });
});

describe('FHIR security', () => {
  it('a nurse with clinical reads but no fhir:read is refused (interop gate)', async () => {
    const res = await app.inject({ method: 'GET', url: `/fhir/Patient/${patientId}`, headers: bearer(nurse.token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().resourceType).toBe('OperationOutcome');
    expect(res.json().issue[0].code).toBe('forbidden');
  });

  it('an unauthenticated request returns a 401 OperationOutcome', async () => {
    const res = await app.inject({ method: 'GET', url: `/fhir/Patient/${patientId}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().resourceType).toBe('OperationOutcome');
  });

  it('a missing patient reference on a compartment search is a 400 OperationOutcome', async () => {
    const res = await app.inject({ method: 'GET', url: '/fhir/Observation', headers: bearer(admin.token) });
    expect(res.statusCode).toBe(400);
    expect(res.json().resourceType).toBe('OperationOutcome');
  });

  it('is tenant-isolated: clinic B cannot read clinic A patient (404 OperationOutcome)', async () => {
    const clinicB = await makeClinic('Clinic B');
    const adminB = await makeUser(clinicB.clinicId, 'adminB', RoleKey.ADMIN);
    const res = await app.inject({ method: 'GET', url: `/fhir/Patient/${patientId}`, headers: bearer(adminB.token) });
    expect(res.statusCode).toBe(404);
    expect(res.json().resourceType).toBe('OperationOutcome');
  });

  it('clinic B cannot read clinic A Organization', async () => {
    const clinicB = await makeClinic('Clinic B');
    const adminB = await makeUser(clinicB.clinicId, 'adminB2', RoleKey.ADMIN);
    const res = await app.inject({ method: 'GET', url: `/fhir/Organization/${clinicId}`, headers: bearer(adminB.token) });
    expect(res.statusCode).toBe(403);
  });
});
