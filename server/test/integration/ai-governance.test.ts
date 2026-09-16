import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { registerAIProvider, resetAIProvider } from '../../src/modules/ai/providers/registry.js';
import type { AIProvider } from '../../src/modules/ai/ai.types.js';

/**
 * A fake CLOUD provider used to prove routing. It carries a secret credential
 * (as a real cloud adapter would) so we can assert the secret never leaks, and
 * counts calls so we can assert it is NOT invoked when policy forbids cloud.
 */
const CLOUD_SECRET = 'sk-cloud-SUPER-SECRET-should-never-appear';
class MockCloudProvider implements AIProvider {
  readonly id = 'mock-cloud';
  readonly model = 'mock-cloud-1';
  readonly tier = 'cloud' as const;
  readonly apiKey = CLOUD_SECRET; // internal credential; not part of the interface surface
  calls = 0;
  async extractIntake() {
    this.calls += 1;
    return { fields: [{ name: 'chiefComplaint', value: 'x' }], citations: [{ ref: 'input-text', kind: 'transcript' }] };
  }
  async summarize() {
    this.calls += 1;
    return { summary: 'cloud summary', citations: [] };
  }
}

let app: FastifyInstance;
let clinicId: string;
let reception: { token: string };
let admin: { token: string };
let cloud: MockCloudProvider;

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function newPatient(name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/patients', headers: bearer(reception.token), payload: { fullName: name, sex: 'female' } });
  return res.json().id;
}
async function runIntake(patientId: string) {
  return app.inject({
    method: 'POST', url: '/ai/intake', headers: bearer(reception.token),
    payload: { subjectType: 'patient', subjectId: patientId, text: 'Chief complaint: fever' },
  });
}
async function setPolicy(token: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/ai/policy', headers: bearer(token), payload: body });
}
async function lastGeneration(): Promise<{ data_class: string; policy_decision: string; provider_tier: string; provider: string }> {
  const { rows } = await getPool().query(
    `SELECT data_class, policy_decision, provider_tier, provider FROM ai_generation
      WHERE clinic_id = $1 ORDER BY created_at DESC LIMIT 1`, [clinicId]);
  return rows[0]!;
}

beforeEach(async () => {
  await resetDb();
  resetAIProvider();
  ({ clinicId } = await makeClinic());
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
  app = buildServer();
  await app.ready();
  cloud = new MockCloudProvider();
  registerAIProvider(cloud); // cloud provider is REGISTERED but may not be used
});
afterEach(() => resetAIProvider());
afterAll(async () => { if (app) await app.close(); });

describe('AI gateway: PHI never reaches cloud by default', () => {
  it('routes PHI intake to the LOCAL provider even when a cloud provider is registered', async () => {
    const patientId = await newPatient('Default Patient');
    const res = await runIntake(patientId);
    expect(res.statusCode).toBe(201);

    // The cloud provider was NOT called; the record proves a local decision.
    expect(cloud.calls).toBe(0);
    const gen = await lastGeneration();
    expect(gen.data_class).toBe('phi');
    expect(gen.policy_decision).toBe('allow_local');
    expect(gen.provider_tier).toBe('local');
    expect(gen.provider).toBe('local-deterministic');
  });

  it('keeps PHI local when cloud is allowed but the ceiling is below PHI', async () => {
    await setPolicy(admin.token, { allowCloud: true, cloudMaxClass: 'operational' });
    const patientId = await newPatient('Ceiling Patient');
    await runIntake(patientId);
    expect(cloud.calls).toBe(0);
    expect((await lastGeneration()).policy_decision).toBe('allow_local');
  });
});

describe('AI gateway: cloud only on explicit opt-in', () => {
  it('routes PHI intake to the cloud provider when the clinic opts in at the PHI ceiling', async () => {
    await setPolicy(admin.token, { allowCloud: true, cloudMaxClass: 'phi' });
    const patientId = await newPatient('Cloud Patient');
    const res = await runIntake(patientId);
    expect(res.statusCode).toBe(201);

    expect(cloud.calls).toBe(1);
    const gen = await lastGeneration();
    expect(gen.policy_decision).toBe('allow_cloud');
    expect(gen.provider_tier).toBe('cloud');
    expect(gen.provider).toBe('mock-cloud');
  });
});

describe('AI gateway: provider secret never leaks', () => {
  it('no cloud credential appears in ai_generation or audit_log after a cloud run', async () => {
    await setPolicy(admin.token, { allowCloud: true, cloudMaxClass: 'phi' });
    const patientId = await newPatient('Secret Patient');
    await runIntake(patientId);
    expect(cloud.calls).toBe(1);

    const gen = await getPool().query<{ blob: string }>(
      `SELECT coalesce(string_agg(row_to_json(ai_generation)::text, ' '), '') AS blob FROM ai_generation WHERE clinic_id = $1`,
      [clinicId]);
    const aud = await getPool().query<{ blob: string }>(
      `SELECT coalesce(string_agg(row_to_json(audit_log)::text, ' '), '') AS blob FROM audit_log WHERE clinic_id = $1`,
      [clinicId]);
    expect(gen.rows[0]!.blob).not.toContain(CLOUD_SECRET);
    expect(aud.rows[0]!.blob).not.toContain(CLOUD_SECRET);
  });
});

describe('AI gateway: tenant isolation', () => {
  it('one clinic opting into cloud does not route another clinic off-box', async () => {
    // Clinic A opts into cloud at PHI.
    await setPolicy(admin.token, { allowCloud: true, cloudMaxClass: 'phi' });
    const patientA = await newPatient('A Patient');
    await runIntake(patientA);
    expect(cloud.calls).toBe(1);

    // Clinic B has no policy → must stay local (fail-closed default).
    const clinicB = await makeClinic('Clinic B');
    const recB = await makeUser(clinicB.clinicId, 'recB', RoleKey.RECEPTION);
    const patB = (await app.inject({ method: 'POST', url: '/patients', headers: bearer(recB.token), payload: { fullName: 'B Patient', sex: 'male' } })).json();
    const bIntake = await app.inject({ method: 'POST', url: '/ai/intake', headers: bearer(recB.token), payload: { subjectType: 'patient', subjectId: patB.id, text: 'Complaint: cough' } });
    expect(bIntake.statusCode).toBe(201);
    expect(cloud.calls).toBe(1); // unchanged — B stayed local
    const bGen = await getPool().query<{ policy_decision: string }>(
      `SELECT policy_decision FROM ai_generation WHERE clinic_id = $1`, [clinicB.clinicId]);
    expect(bGen.rows[0]!.policy_decision).toBe('allow_local');
  });
});

describe('AI policy: authorization', () => {
  it('only an admin can read or set the AI policy', async () => {
    expect((await app.inject({ method: 'GET', url: '/ai/policy', headers: bearer(reception.token) })).statusCode).toBe(403);
    expect((await setPolicy(reception.token, { allowCloud: true })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/ai/policy', headers: bearer(admin.token) })).statusCode).toBe(200);
  });

  it('a pharma rep cannot touch the AI policy', async () => {
    const pharma = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
    expect((await app.inject({ method: 'GET', url: '/ai/policy', headers: bearer(pharma.token) })).statusCode).toBe(403);
    expect((await setPolicy(pharma.token, { allowCloud: true })).statusCode).toBe(403);
  });

  it('round-trips a policy via the API', async () => {
    const set = await setPolicy(admin.token, { allowCloud: true, cloudMaxClass: 'phi' });
    expect(set.statusCode).toBe(201);
    const get = await app.inject({ method: 'GET', url: '/ai/policy', headers: bearer(admin.token) });
    expect(get.json()).toMatchObject({ allowCloud: true, cloudMaxClass: 'phi' });
  });
});
