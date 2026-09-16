import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

/**
 * FIELD FORCE (migration 0309) — representative profiles, the reporting
 * hierarchy, visit modality, institutional calls and the visit status trail.
 */

let app: FastifyInstance;
let clinicId: string;
let manager: TestUser;      // PHARMA_MANAGER — holds territory:manage
let district: TestUser;     // a district manager: no territory:manage, has reports
let repA: TestUser;         // reports to `district`
let repB: TestUser;         // reports to nobody
let steward: TestUser;

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const PROV = { source: 'field_rep', jurisdiction: 'EG' };

let hcpId: string;
let hcoId: string;
let territoryId: string;

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  user: TestUser,
  payload?: Record<string, unknown>,
) {
  return app.inject({ method, url, headers: auth(user), ...(payload ? { payload } : {}) });
}

async function ok(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  user: TestUser,
  payload?: Record<string, unknown>,
) {
  const res = await call(method, url, user, payload);
  if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
  return res.json();
}

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  manager = await makeUser(clinicId, 'ff-manager', RoleKey.PHARMA_MANAGER);
  district = await makeUser(clinicId, 'ff-district', RoleKey.PHARMA_REP);
  repA = await makeUser(clinicId, 'ff-rep-a', RoleKey.PHARMA_REP);
  repB = await makeUser(clinicId, 'ff-rep-b', RoleKey.PHARMA_REP);
  steward = await makeUser(clinicId, 'ff-steward', RoleKey.PHARMA_DATA_STEWARD);

  const territory = await ok('POST', '/territories', manager, {
    code: 'N',
    name: 'North',
    country: 'EG',
  });
  territoryId = territory.id;
  for (const user of [district, repA, repB]) {
    await ok('POST', `/territories/${territoryId}/assignments`, manager, { userId: user.userId });
  }

  const hcp = await ok('POST', '/hcps', steward, {
    fullName: 'Dr Field Subject',
    professionalCategory: 'physician',
    provenance: PROV,
  });
  hcpId = hcp.id;
  await ok('POST', `/territories/${territoryId}/targets`, manager, { hcpId });

  const hco = await ok('POST', '/hcos', steward, {
    name: 'Nile Teaching Hospital',
    country: 'EG',
    provenance: PROV,
  });
  hcoId = hco.id;
});

afterAll(async () => {
  if (app) await app.close();
});

describe('field-force profiles', () => {
  it('records a representative’s employment and reporting line', async () => {
    const profile = await ok('PUT', '/field-force/profiles', manager, {
      userId: repA.userId,
      repRole: 'representative',
      managerUserId: district.userId,
      region: 'Greater Cairo',
    });
    expect(profile.userId).toBe(repA.userId);
    expect(profile.managerUserId).toBe(district.userId);
    expect(profile.status).toBe('active');
  });

  it('a re-import corrects the existing profile instead of conflicting', async () => {
    const first = await ok('PUT', '/field-force/profiles', manager, { userId: repA.userId });
    const second = await ok('PUT', '/field-force/profiles', manager, {
      userId: repA.userId,
      repRole: 'senior_representative',
      status: 'on_leave',
    });
    expect(second.id).toBe(first.id);
    expect(second.repRole).toBe('senior_representative');
    expect(second.status).toBe('on_leave');
  });

  it('a representative cannot edit the field force', async () => {
    const res = await call('PUT', '/field-force/profiles', repA, { userId: repA.userId });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a manager from another clinic', async () => {
    const other = await makeClinic('Other FF Clinic');
    const outsider = await makeUser(other.clinicId, 'outsider', RoleKey.PHARMA_REP);
    const res = await call('PUT', '/field-force/profiles', manager, {
      userId: repA.userId,
      managerUserId: outsider.userId,
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a self-managing profile', async () => {
    const res = await call('PUT', '/field-force/profiles', manager, {
      userId: repA.userId,
      managerUserId: repA.userId,
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses a reporting CYCLE, which would make visibility unanswerable', async () => {
    await ok('PUT', '/field-force/profiles', manager, {
      userId: repA.userId,
      managerUserId: district.userId,
    });
    const res = await call('PUT', '/field-force/profiles', manager, {
      userId: district.userId,
      managerUserId: repA.userId,
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses an end date before the start date', async () => {
    const res = await call('PUT', '/field-force/profiles', manager, {
      userId: repA.userId,
      startDate: '2026-06-01',
      endDate: '2026-01-01',
    });
    expect(res.statusCode).toBe(400);
  });

  it('every field-force endpoint requires authentication', async () => {
    for (const [method, url] of [
      ['PUT', '/field-force/profiles'],
      ['GET', '/field-force/profiles'],
      ['GET', `/field-force/profiles/${repA.userId}`],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('field-force hierarchy — a manager reaches their subtree, not the clinic', () => {
  beforeEach(async () => {
    await ok('PUT', '/field-force/profiles', manager, {
      userId: district.userId,
      repRole: 'district_manager',
    });
    await ok('PUT', '/field-force/profiles', manager, {
      userId: repA.userId,
      managerUserId: district.userId,
    });
    await ok('PUT', '/field-force/profiles', manager, { userId: repB.userId });
  });

  it('a territory:manage holder sees the whole field force', async () => {
    const body = await ok('GET', '/field-force/profiles', manager);
    expect(body.results).toHaveLength(3);
  });

  it('a district manager sees themselves and their reports — and nobody else', async () => {
    const body = await ok('GET', '/field-force/profiles', district);
    const ids = body.results.map((p: { userId: string }) => p.userId).sort();
    expect(ids).toEqual([district.userId, repA.userId].sort());
    expect(ids).not.toContain(repB.userId);
  });

  it('an ordinary representative sees exactly themselves', async () => {
    const body = await ok('GET', '/field-force/profiles', repB);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].userId).toBe(repB.userId);
  });

  it('a peer cannot open another representative’s profile', async () => {
    const res = await call('GET', `/field-force/profiles/${repA.userId}`, repB);
    expect(res.statusCode).toBe(403);
  });

  it('a manager can open the profile of someone who reports to them', async () => {
    const body = await ok('GET', `/field-force/profiles/${repA.userId}`, district);
    expect(body.profile.userId).toBe(repA.userId);
    expect(body.managerChain).toContain(district.userId);
  });

  it('a manager may act on a subordinate’s visit without a clinic-wide grant', async () => {
    const visit = await ok('POST', '/visits', repA, { hcpId, plannedAt: tomorrow() });
    const res = await call('POST', `/visits/${visit.id}/status`, district, {
      status: 'cancelled',
      reason: 'Physician on leave',
    });
    expect(res.statusCode).toBe(200);
  });

  it('a peer may NOT act on another representative’s visit', async () => {
    const visit = await ok('POST', '/visits', repA, { hcpId, plannedAt: tomorrow() });
    const res = await call('POST', `/visits/${visit.id}/status`, repB, {
      status: 'cancelled',
      reason: 'not mine',
    });
    expect(res.statusCode).toBe(403);
  });

  it('a deep chain is walked, and a cycle planted directly in the table cannot hang it', async () => {
    // The service refuses cycles; this writes one straight past it to prove the
    // recursive walk is guarded rather than merely un-provoked.
    await getPool().query(
      `UPDATE field_rep_profile SET manager_user_id = $1 WHERE user_id = $2`,
      [repA.userId, district.userId],
    );
    const body = await ok('GET', '/field-force/profiles', district);
    expect(body.results.length).toBeGreaterThan(0);
  });
});

describe('visit modality and institutional calls', () => {
  it('records HOW a call happened, independently of why', async () => {
    const visit = await ok('POST', '/visits', repA, {
      hcpId,
      plannedAt: tomorrow(),
      visitType: 'scientific',
      modality: 'virtual',
    });
    expect(visit.modality).toBe('virtual');
    expect(visit.visitType).toBe('scientific');
  });

  it('defaults to face_to_face rather than guessing something more specific', async () => {
    const visit = await ok('POST', '/visits', repA, { hcpId, plannedAt: tomorrow() });
    expect(visit.modality).toBe('face_to_face');
  });

  it('filters the day book by modality', async () => {
    await ok('POST', '/visits', repA, { hcpId, plannedAt: tomorrow(), modality: 'virtual' });
    await ok('POST', '/visits', repA, { hcpId, plannedAt: tomorrow(), modality: 'phone' });
    const body = await ok('GET', '/visits?modality=virtual', repA);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].modality).toBe('virtual');
  });

  it('plans an INSTITUTIONAL call with an organisation and no professional', async () => {
    const visit = await ok('POST', '/visits', repA, {
      hcoId,
      plannedAt: tomorrow(),
      modality: 'institutional',
    });
    expect(visit.hcpId).toBeNull();
    expect(visit.hcoId).toBe(hcoId);
  });

  it('refuses a visit with neither a professional nor an organisation', async () => {
    const res = await call('POST', '/visits', repA, { plannedAt: tomorrow() });
    expect(res.statusCode).toBe(400);
  });

  it('the database refuses a subject-less visit even by direct insert', async () => {
    await expect(
      getPool().query(
        `INSERT INTO visit (clinic_id, rep_user_id, planned_at) VALUES ($1,$2, now())`,
        [clinicId, repA.userId],
      ),
    ).rejects.toThrow();
  });

  it('an institutional call still appears in the visit list', async () => {
    await ok('POST', '/visits', repA, { hcoId, plannedAt: tomorrow() });
    const body = await ok('GET', '/visits', repA);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].hcoName).toBe('Nile Teaching Hospital');
  });

  it('briefs an institutional call without inventing a professional', async () => {
    const visit = await ok('POST', '/visits', repA, { hcoId, plannedAt: tomorrow() });
    const briefing = await ok('GET', `/visits/${visit.id}/briefing`, repA);
    expect(briefing.hcp).toBeNull();
    expect(briefing.specialties).toEqual([]);
    expect(briefing.dataBoundary).toContain('no patient data');
  });

  it('an institutional call can be reported on', async () => {
    const visit = await ok('POST', '/visits', repA, { hcoId, plannedAt: tomorrow() });
    const report = await ok('POST', `/visits/${visit.id}/call-report`, repA, {
      summary: 'Met the procurement lead; formulary review scheduled.',
      followUps: [{ action: 'Send formulary dossier', dueDate: '2026-12-01' }],
    });
    expect(report.hcpId).toBeNull();
    expect(report.followUps).toHaveLength(1);
  });

  it('refuses planning against a merged organisation', async () => {
    const survivor = await ok('POST', '/hcos', steward, {
      name: 'Survivor Hospital',
      country: 'EG',
      provenance: PROV,
    });
    await ok('POST', `/hcos/${hcoId}/merge`, steward, {
      survivorHcoId: survivor.id,
      reason: 'duplicate',
    });
    const res = await call('POST', '/visits', repA, { hcoId, plannedAt: tomorrow() });
    expect(res.statusCode).toBe(409);
  });
});

describe('visit status trail', () => {
  it('records the planning of a visit as its first event', async () => {
    const visit = await ok('POST', '/visits', repA, { hcpId, plannedAt: tomorrow() });
    const body = await ok('GET', `/visits/${visit.id}/history`, repA);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].fromStatus).toBeNull();
    expect(body.events[0].toStatus).toBe('planned');
  });

  it('records every transition with its actor and reason', async () => {
    const visit = await ok('POST', '/visits', repA, { hcpId, plannedAt: tomorrow() });
    await ok('POST', `/visits/${visit.id}/status`, repA, { status: 'confirmed' });
    await ok('POST', `/visits/${visit.id}/status`, repA, {
      status: 'no_access',
      reason: 'Reception refused entry',
    });
    const body = await ok('GET', `/visits/${visit.id}/history`, repA);
    expect(body.events.map((e: { toStatus: string }) => e.toStatus)).toEqual([
      'planned',
      'confirmed',
      'no_access',
    ]);
    const last = body.events[2];
    expect(last.reason).toBe('Reception refused entry');
    expect(last.actorId).toBe(repA.userId);
  });

  it('refuses an unexplained cancellation', async () => {
    const visit = await ok('POST', '/visits', repA, { hcpId, plannedAt: tomorrow() });
    const res = await call('POST', `/visits/${visit.id}/status`, repA, { status: 'cancelled' });
    expect(res.statusCode).toBe(400);
  });

  it('refuses re-opening a closed visit', async () => {
    const visit = await ok('POST', '/visits', repA, { hcpId, plannedAt: tomorrow() });
    await ok('POST', `/visits/${visit.id}/status`, repA, {
      status: 'cancelled',
      reason: 'Physician travelling',
    });
    const res = await call('POST', `/visits/${visit.id}/status`, repA, { status: 'confirmed' });
    expect(res.statusCode).toBe(409);
  });

  it('a call report closes the visit and the trail says so', async () => {
    const visit = await ok('POST', '/visits', repA, { hcpId, plannedAt: tomorrow() });
    await ok('POST', `/visits/${visit.id}/call-report`, repA, { summary: 'Detailed product A.' });
    const body = await ok('GET', `/visits/${visit.id}/history`, repA);
    expect(body.events.map((e: { toStatus: string }) => e.toStatus)).toEqual([
      'planned',
      'completed',
    ]);
    const visits = await ok('GET', '/visits', repA);
    expect(visits.results[0].status).toBe('completed');
  });

  it('the trail cannot be edited or erased', async () => {
    const visit = await ok('POST', '/visits', repA, { hcpId, plannedAt: tomorrow() });
    await expect(
      getPool().query(`UPDATE visit_event SET to_status = 'completed' WHERE visit_id = $1`, [
        visit.id,
      ]),
    ).rejects.toThrow();
    await expect(
      getPool().query(`DELETE FROM visit_event WHERE visit_id = $1`, [visit.id]),
    ).rejects.toThrow();
  });

  it('a peer cannot read another representative’s visit trail', async () => {
    const visit = await ok('POST', '/visits', repA, { hcpId, plannedAt: tomorrow() });
    const res = await call('GET', `/visits/${visit.id}/history`, repB);
    expect(res.statusCode).toBe(403);
  });
});
