import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

let app: FastifyInstance;
let clinicId: string;
let manager: TestUser;
let repNorth: TestUser;
let repSouth: TestUser;
let north: { id: string };
let south: { id: string };
let hcpNorth: { id: string };
let hcpSouth: { id: string };

const PROVENANCE = { source: 'field_rep', jurisdiction: 'EG' };

function auth(user: TestUser) {
  return { authorization: `Bearer ${user.token}` };
}

async function createTerritory(code: string, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/territories',
    headers: auth(manager),
    payload: { code, name, country: 'EG' },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function createHcp(fullName: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/hcps',
    headers: auth(manager),
    payload: { fullName, provenance: PROVENANCE },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function target(territoryId: string, hcpId: string, tier = 'A') {
  const res = await app.inject({
    method: 'POST',
    url: `/territories/${territoryId}/targets`,
    headers: auth(manager),
    payload: { hcpId, tier, targetVisitsPerQuarter: 4 },
  });
  expect(res.statusCode).toBe(201);
}

async function assign(territoryId: string, user: TestUser) {
  const res = await app.inject({
    method: 'POST',
    url: `/territories/${territoryId}/assignments`,
    headers: auth(manager),
    payload: { userId: user.userId, assignmentRole: 'primary_rep' },
  });
  expect(res.statusCode).toBe(201);
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  manager = await makeUser(clinicId, 'manager', RoleKey.ADMIN);
  repNorth = await makeUser(clinicId, 'rep-north', RoleKey.PHARMA_REP);
  repSouth = await makeUser(clinicId, 'rep-south', RoleKey.PHARMA_REP);

  north = await createTerritory('CAI-N', 'Cairo North');
  south = await createTerritory('CAI-S', 'Cairo South');
  hcpNorth = await createHcp('Dr North Physician');
  hcpSouth = await createHcp('Dr South Physician');
  await target(north.id, hcpNorth.id);
  await target(south.id, hcpSouth.id);
  await assign(north.id, repNorth);
  await assign(south.id, repSouth);
});

afterAll(async () => {
  if (app) await app.close();
});

describe('territory — definition is a management act', () => {
  it('a representative cannot create a territory or assign themselves to one', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/territories',
      headers: auth(repNorth),
      payload: { code: 'MINE', name: 'Everything', country: 'EG' },
    });
    expect(create.statusCode).toBe(403);

    const assignSelf = await app.inject({
      method: 'POST',
      url: `/territories/${south.id}/assignments`,
      headers: auth(repNorth),
      payload: { userId: repNorth.userId },
    });
    expect(assignSelf.statusCode).toBe(403);
  });

  it('a representative cannot target an HCP into their territory', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/territories/${north.id}/targets`,
      headers: auth(repNorth),
      payload: { hcpId: hcpSouth.id },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns the representative's own book of business", async () => {
    const res = await app.inject({ method: 'GET', url: '/rep/territory', headers: auth(repNorth) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0].territoryCode).toBe('CAI-N');
    expect(body.targets.map((t: { hcpId: string }) => t.hcpId)).toEqual([hcpNorth.id]);
  });

  it('refuses a duplicate open assignment', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/territories/${north.id}/assignments`,
      headers: auth(manager),
      payload: { userId: repNorth.userId, assignmentRole: 'primary_rep' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('territory scope — a representative sees only their own HCPs', () => {
  it('search returns only HCPs targeted in an assigned territory', async () => {
    const res = await app.inject({ method: 'GET', url: '/hcps', headers: auth(repNorth) });
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((h: { id: string }) => h.id)).toEqual([hcpNorth.id]);
  });

  it('opening the 360 of an out-of-territory HCP is forbidden', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/hcps/${hcpSouth.id}`,
      headers: auth(repNorth),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/not targeted in a territory assigned to you/i);
  });

  it('planning a visit on an out-of-territory HCP is forbidden', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/visits',
      headers: auth(repNorth),
      payload: { hcpId: hcpSouth.id, plannedAt: new Date().toISOString() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a representative with no territory sees nothing rather than everything', async () => {
    const unassigned = await makeUser(clinicId, 'rep-new', RoleKey.PHARMA_REP);
    const search = await app.inject({ method: 'GET', url: '/hcps', headers: auth(unassigned) });
    expect(search.json().results).toEqual([]);

    const read = await app.inject({
      method: 'GET',
      url: `/hcps/${hcpNorth.id}`,
      headers: auth(unassigned),
    });
    expect(read.statusCode).toBe(403);
  });

  it('a manager sees the whole clinic', async () => {
    const res = await app.inject({ method: 'GET', url: '/hcps', headers: auth(manager) });
    expect(res.json().results).toHaveLength(2);
  });
});

describe('visit planning and the day list', () => {
  it('plans a visit, defaults its territory from targeting, and lists it for today', async () => {
    const plan = await app.inject({
      method: 'POST',
      url: '/visits',
      headers: auth(repNorth),
      payload: {
        hcpId: hcpNorth.id,
        plannedAt: new Date().toISOString(),
        visitType: 'detail',
        objective: 'introduce the new formulation',
      },
    });
    expect(plan.statusCode).toBe(201);
    expect(plan.json().territoryId).toBe(north.id);
    expect(plan.json().repUserId).toBe(repNorth.userId);

    const today = await app.inject({ method: 'GET', url: '/rep/today', headers: auth(repNorth) });
    expect(today.json().visits).toHaveLength(1);

    // Another representative's day is their own.
    const otherDay = await app.inject({ method: 'GET', url: '/rep/today', headers: auth(repSouth) });
    expect(otherDay.json().visits).toEqual([]);
  });

  it('a representative cannot plan a visit for another representative', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/visits',
      headers: auth(repNorth),
      payload: {
        hcpId: hcpNorth.id,
        plannedAt: new Date().toISOString(),
        repUserId: repSouth.userId,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a manager can plan on behalf of a representative', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/visits',
      headers: auth(manager),
      payload: {
        hcpId: hcpNorth.id,
        plannedAt: new Date().toISOString(),
        repUserId: repNorth.userId,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().repUserId).toBe(repNorth.userId);
  });
});

describe('pre-visit briefing', () => {
  it('assembles the professional picture and open items, and no patient data', async () => {
    await app.inject({
      method: 'POST',
      url: `/hcps/${hcpNorth.id}/interests`,
      headers: auth(manager),
      payload: { interest: 'heart failure', strength: 'high', source: 'field_rep' },
    });
    const visit = (
      await app.inject({
        method: 'POST',
        url: '/visits',
        headers: auth(repNorth),
        payload: { hcpId: hcpNorth.id, plannedAt: new Date().toISOString() },
      })
    ).json();

    const res = await app.inject({
      method: 'GET',
      url: `/visits/${visit.id}/briefing`,
      headers: auth(repNorth),
    });
    expect(res.statusCode).toBe(200);
    const brief = res.json();
    expect(brief.hcp.id).toBe(hcpNorth.id);
    expect(brief.interests[0].interest).toBe('heart failure');
    expect(brief.territories[0].code).toBe('CAI-N');
    expect(brief.openObjections).toEqual([]);
    expect(brief.dataBoundary).toMatch(/no patient data/i);
    // Nothing clinical is even shaped into this response.
    expect(Object.keys(brief)).not.toContain('patients');
  });
});

describe('call report', () => {
  async function planVisit() {
    return (
      await app.inject({
        method: 'POST',
        url: '/visits',
        headers: auth(repNorth),
        payload: { hcpId: hcpNorth.id, plannedAt: new Date().toISOString() },
      })
    ).json();
  }

  it('captures the discussion, objections, competitors and follow-ups, and closes the visit', async () => {
    const visit = await planVisit();
    const res = await app.inject({
      method: 'POST',
      url: `/visits/${visit.id}/call-report`,
      headers: auth(repNorth),
      payload: {
        summary: 'Discussed the new formulation; positive reception overall.',
        hcpSentiment: 'positive',
        nextStep: 'Send the dosing leaflet',
        products: [{ productLabel: 'Cidophage', discussionOutcome: 'interested' }],
        objections: [
          { objectionType: 'cost', objectionText: 'Concerned about out-of-pocket cost' },
        ],
        competitors: [
          { competitorName: 'Rival Pharma', competitorProduct: 'Rivaform', sentiment: 'neutral' },
        ],
        followUps: [{ action: 'Send dosing leaflet', dueDate: '2026-12-31' }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().followUps).toHaveLength(1);

    const reread = await app.inject({
      method: 'GET',
      url: `/visits/${visit.id}/call-report`,
      headers: auth(repNorth),
    });
    expect(reread.json().hcpSentiment).toBe('positive');

    const visits = await app.inject({
      method: 'GET',
      url: `/visits?hcpId=${hcpNorth.id}`,
      headers: auth(repNorth),
    });
    expect(visits.json().results[0].status).toBe('completed');

    const followUps = await app.inject({
      method: 'GET',
      url: '/rep/follow-ups',
      headers: auth(repNorth),
    });
    expect(followUps.json().results).toHaveLength(1);
  });

  it('refuses a second call report for the same visit', async () => {
    const visit = await planVisit();
    const payload = { summary: 'First report' };
    await app.inject({
      method: 'POST',
      url: `/visits/${visit.id}/call-report`,
      headers: auth(repNorth),
      payload,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/visits/${visit.id}/call-report`,
      headers: auth(repNorth),
      payload,
    });
    expect(res.statusCode).toBe(409);
  });

  it("refuses to report on another representative's visit", async () => {
    const visit = await planVisit();
    const res = await app.inject({
      method: 'POST',
      url: `/visits/${visit.id}/call-report`,
      headers: auth(repSouth),
      payload: { summary: 'Not my visit' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('completes a follow-up action and records the event', async () => {
    const visit = await planVisit();
    const report = (
      await app.inject({
        method: 'POST',
        url: `/visits/${visit.id}/call-report`,
        headers: auth(repNorth),
        payload: {
          summary: 'Agreed to review the data',
          followUps: [{ action: 'Share reprint', dueDate: '2026-12-31' }],
        },
      })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: `/follow-ups/${report.followUps[0].id}/complete`,
      headers: auth(repNorth),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('done');

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event WHERE type = 'FOLLOW_UP_COMPLETED'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

describe('scientific requests', () => {
  it('a representative raises a question and medical affairs answers it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/scientific-requests',
      headers: auth(repNorth),
      payload: {
        hcpId: hcpNorth.id,
        requestType: 'dosing',
        question: 'Is dose adjustment needed in moderate renal impairment?',
        urgency: 'high',
      },
    });
    expect(created.statusCode).toBe(201);
    const request = created.json();
    expect(request.status).toBe('open');

    // The representative who raised it cannot answer it.
    const repAnswer = await app.inject({
      method: 'POST',
      url: `/scientific-requests/${request.id}/answer`,
      headers: auth(repNorth),
      payload: { decision: 'answer', answerSummary: 'I think so' },
    });
    expect(repAnswer.statusCode).toBe(403);

    const answered = await app.inject({
      method: 'POST',
      url: `/scientific-requests/${request.id}/answer`,
      headers: auth(manager),
      payload: { decision: 'answer', answerSummary: 'See the approved dosing summary.' },
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toMatchObject({ status: 'answered' });
    expect(answered.json().answeredAt).not.toBeNull();
  });

  it('refuses an answer with no summary and no cited content', async () => {
    const request = (
      await app.inject({
        method: 'POST',
        url: '/scientific-requests',
        headers: auth(repNorth),
        payload: { hcpId: hcpNorth.id, question: 'Any long-term outcome data?' },
      })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/scientific-requests/${request.id}/answer`,
      headers: auth(manager),
      payload: { decision: 'answer' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('a representative only sees requests for HCPs in their territory', async () => {
    await app.inject({
      method: 'POST',
      url: '/scientific-requests',
      headers: auth(repNorth),
      payload: { hcpId: hcpNorth.id, question: 'North question' },
    });
    await app.inject({
      method: 'POST',
      url: '/scientific-requests',
      headers: auth(repSouth),
      payload: { hcpId: hcpSouth.id, question: 'South question' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/scientific-requests',
      headers: auth(repNorth),
    });
    expect(res.json().results).toHaveLength(1);
    expect(res.json().results[0].question).toBe('North question');
  });
});
