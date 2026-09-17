import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

/**
 * MEDICAL AFFAIRS (migration 0310) — triage, service levels, escalation,
 * separation of duties and the append-only request trail.
 */

let app: FastifyInstance;
let clinicId: string;
let rep: TestUser;
let affairsA: TestUser;
let affairsB: TestUser;
let manager: TestUser;
let steward: TestUser;

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const PROV = { source: 'field_rep', jurisdiction: 'EG' };

let hcpId: string;
let territoryId: string;

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  user: TestUser,
  payload?: Record<string, unknown>,
) {
  return app.inject({ method, url, headers: auth(user), ...(payload ? { payload } : {}) });
}

async function ok(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  user: TestUser,
  payload?: Record<string, unknown>,
) {
  const res = await call(method, url, user, payload);
  if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
  return res.json();
}

async function raise(overrides: Record<string, unknown> = {}, as: TestUser = rep) {
  return ok('POST', '/scientific-requests', as, {
    hcpId,
    question: 'What is the recommended dose adjustment in moderate renal impairment?',
    ...overrides,
  });
}

/** Push a request past its service level without waiting for real time. */
async function breach(requestId: string) {
  await getPool().query(
    `UPDATE scientific_request SET sla_due_at = now() - interval '2 hours' WHERE id = $1`,
    [requestId],
  );
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  rep = await makeUser(clinicId, 'ma-rep', RoleKey.PHARMA_REP);
  affairsA = await makeUser(clinicId, 'ma-affairs-a', RoleKey.MEDICAL_AFFAIRS);
  affairsB = await makeUser(clinicId, 'ma-affairs-b', RoleKey.MEDICAL_AFFAIRS);
  manager = await makeUser(clinicId, 'ma-manager', RoleKey.PHARMA_MANAGER);
  steward = await makeUser(clinicId, 'ma-steward', RoleKey.PHARMA_DATA_STEWARD);

  const territory = await ok('POST', '/territories', manager, {
    code: 'N',
    name: 'North',
    country: 'EG',
  });
  territoryId = territory.id;
  await ok('POST', `/territories/${territoryId}/assignments`, manager, { userId: rep.userId });

  const hcp = await ok('POST', '/hcps', steward, {
    fullName: 'Dr Enquiring Physician',
    professionalCategory: 'physician',
    provenance: PROV,
  });
  hcpId = hcp.id;
  await ok('POST', `/territories/${territoryId}/targets`, manager, { hcpId });
});

afterAll(async () => {
  if (app) await app.close();
});

describe('medical affairs — raising a request', () => {
  it('records the medical classification, priority, channel and a service level', async () => {
    const request = await raise({ inquiryCategory: 'dosing_administration', priority: 'high' });
    expect(request.inquiryCategory).toBe('dosing_administration');
    expect(request.priority).toBe('high');
    expect(request.sourceChannel).toBe('field_visit');
    expect(request.slaDueAt).not.toBeNull();
    expect(request.slaBreached).toBe(false);
  });

  it('does not classify the question on the asker’s behalf', async () => {
    const request = await raise();
    expect(request.inquiryCategory).toBe('unclassified');
  });

  it('a more urgent question gets a nearer deadline', async () => {
    const routine = await raise({ priority: 'routine' });
    const critical = await raise({ priority: 'critical' });
    expect(new Date(critical.slaDueAt).getTime()).toBeLessThan(
      new Date(routine.slaDueAt).getTime(),
    );
  });

  it('the clock starts when the question is asked, not when someone picks it up', async () => {
    const request = await raise({ priority: 'critical' });
    // Never triaged, yet it can still breach — an unattended queue must.
    await breach(request.id);
    const detail = await ok('GET', `/scientific-requests/${request.id}`, affairsA);
    expect(detail.request.slaBreached).toBe(true);
  });

  it('refuses a question carrying a patient identifier', async () => {
    const res = await call('POST', '/scientific-requests', rep, {
      hcpId,
      question: 'Dose for patient MRN-000123 with renal impairment?',
    });
    expect(res.statusCode).toBe(400);
  });

  it('writes the raising of the request as its first trail entry', async () => {
    const request = await raise();
    const detail = await ok('GET', `/scientific-requests/${request.id}`, affairsA);
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0].eventType).toBe('created');
    expect(detail.events[0].toStatus).toBe('open');
  });
});

describe('medical affairs — triage', () => {
  it('assigns a request and moves it into review', async () => {
    const request = await raise();
    const triaged = await ok('POST', `/scientific-requests/${request.id}/triage`, affairsA, {
      assignedTo: affairsB.userId,
      inquiryCategory: 'safety',
      priority: 'critical',
    });
    expect(triaged.assignedTo).toBe(affairsB.userId);
    expect(triaged.assignedBy).toBe(affairsA.userId);
    expect(triaged.status).toBe('in_review');
    expect(triaged.inquiryCategory).toBe('safety');
  });

  it('re-prioritising resets the clock, because the commitment changed', async () => {
    const request = await raise({ priority: 'routine' });
    const triaged = await ok('POST', `/scientific-requests/${request.id}/triage`, affairsA, {
      assignedTo: affairsB.userId,
      priority: 'critical',
    });
    expect(new Date(triaged.slaDueAt).getTime()).toBeLessThan(
      new Date(request.slaDueAt).getTime(),
    );
  });

  it('hands a request back to the queue', async () => {
    const request = await raise();
    await ok('POST', `/scientific-requests/${request.id}/triage`, affairsA, {
      assignedTo: affairsB.userId,
    });
    const returned = await ok('POST', `/scientific-requests/${request.id}/triage`, affairsA, {
      assignedTo: null,
    });
    expect(returned.assignedTo).toBeNull();
    expect(returned.assignedAt).toBeNull();
    expect(returned.status).toBe('open');
  });

  it('refuses routing a medical question to someone who cannot answer it', async () => {
    const request = await raise();
    const res = await call('POST', `/scientific-requests/${request.id}/triage`, affairsA, {
      assignedTo: rep.userId,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an assignee from another clinic', async () => {
    const other = await makeClinic('Other MA Clinic');
    const outsider = await makeUser(other.clinicId, 'outsider', RoleKey.MEDICAL_AFFAIRS);
    const request = await raise();
    const res = await call('POST', `/scientific-requests/${request.id}/triage`, affairsA, {
      assignedTo: outsider.userId,
    });
    expect(res.statusCode).toBe(400);
  });

  it('a representative cannot triage', async () => {
    const request = await raise();
    const res = await call('POST', `/scientific-requests/${request.id}/triage`, rep, {
      assignedTo: affairsA.userId,
    });
    expect(res.statusCode).toBe(403);
  });

  it('an answered request is out of triage', async () => {
    const request = await raise();
    await ok('POST', `/scientific-requests/${request.id}/answer`, affairsA, {
      answerSummary: 'Reduce by one third; see the approved summary of product characteristics.',
    });
    const res = await call('POST', `/scientific-requests/${request.id}/triage`, affairsA, {
      assignedTo: affairsB.userId,
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('medical affairs — answering', () => {
  it('records the answer and closes the question', async () => {
    const request = await raise();
    const answered = await ok('POST', `/scientific-requests/${request.id}/answer`, affairsA, {
      answerSummary: 'Reduce by one third in moderate impairment.',
    });
    expect(answered.status).toBe('answered');
    expect(answered.answeredBy).toBe(affairsA.userId);
  });

  it('SEPARATION OF DUTIES: the person who asked cannot answer, even with the permission', async () => {
    // Raised BY medical affairs themselves (they hold both permissions).
    const request = await raise({}, affairsA);
    const res = await call('POST', `/scientific-requests/${request.id}/answer`, affairsA, {
      answerSummary: 'Answering my own question.',
    });
    expect(res.statusCode).toBe(409);
    const byColleague = await call('POST', `/scientific-requests/${request.id}/answer`, affairsB, {
      answerSummary: 'Reduce by one third in moderate impairment.',
    });
    expect(byColleague.statusCode).toBe(200);
  });

  it('refuses an answer with neither a summary nor cited content', async () => {
    const request = await raise();
    const res = await call('POST', `/scientific-requests/${request.id}/answer`, affairsA, {});
    expect(res.statusCode).toBe(400);
  });

  it('a rejection without a reason is refused', async () => {
    const request = await raise();
    const res = await call('POST', `/scientific-requests/${request.id}/answer`, affairsA, {
      decision: 'reject',
    });
    expect(res.statusCode).toBe(400);
  });

  it('a rejection with a reason is kept and cannot later become an answer', async () => {
    const request = await raise();
    const rejected = await ok('POST', `/scientific-requests/${request.id}/answer`, affairsA, {
      decision: 'reject',
      reason: 'Off-label enquiry; cannot be answered promotionally.',
    });
    expect(rejected.status).toBe('rejected');
    const res = await call('POST', `/scientific-requests/${request.id}/answer`, affairsA, {
      answerSummary: 'Actually, here is a dose.',
    });
    expect(res.statusCode).toBe(409);
  });

  it('closing an UNANSWERED request without a reason is refused (audit)', async () => {
    const request = await raise();
    const bare = await call('POST', `/scientific-requests/${request.id}/answer`, affairsA, {
      decision: 'close',
    });
    // Before this, `close` was an unexplained refusal that walked past the rule
    // `reject` is held to: a clinician asked something and the file shut.
    expect(bare.statusCode).toBe(400);

    const closed = await ok('POST', `/scientific-requests/${request.id}/answer`, affairsA, {
      decision: 'close',
      reason: 'Enquirer withdrew the question at the next call',
    });
    expect(closed.status).toBe('closed');
    expect(closed.answerSummary).toContain('withdrew');
  });

  it('closing an ANSWERED request is housekeeping and needs no second rationale', async () => {
    const request = await raise();
    await ok('POST', `/scientific-requests/${request.id}/answer`, affairsA, {
      answerSummary: 'Reduce by one third in moderate impairment.',
    });
    const closed = await ok('POST', `/scientific-requests/${request.id}/answer`, affairsA, {
      decision: 'close',
    });
    expect(closed.status).toBe('closed');
    // The original answer is the decision of record and must survive the close.
    expect(closed.answerSummary).toContain('one third');
  });

  it('a representative cannot answer a scientific question', async () => {
    const request = await raise();
    const res = await call('POST', `/scientific-requests/${request.id}/answer`, rep, {
      answerSummary: 'I think it is fine.',
    });
    expect(res.statusCode).toBe(403);
  });

  it('records the answer in the append-only trail', async () => {
    const request = await raise();
    await ok('POST', `/scientific-requests/${request.id}/triage`, affairsA, {
      assignedTo: affairsB.userId,
    });
    await ok('POST', `/scientific-requests/${request.id}/answer`, affairsB, {
      answerSummary: 'Reduce by one third.',
    });
    const detail = await ok('GET', `/scientific-requests/${request.id}`, affairsA);
    expect(detail.events.map((e: { eventType: string }) => e.eventType)).toEqual([
      'created',
      'assigned',
      'answered',
    ]);
  });

  it('the trail cannot be edited or erased', async () => {
    const request = await raise();
    await expect(
      getPool().query(`UPDATE scientific_request_event SET reason = 'x' WHERE request_id = $1`, [
        request.id,
      ]),
    ).rejects.toThrow();
    await expect(
      getPool().query(`DELETE FROM scientific_request_event WHERE request_id = $1`, [request.id]),
    ).rejects.toThrow();
  });
});

describe('medical affairs — escalation', () => {
  it('a breached request can be escalated, with a reason and an attributed actor', async () => {
    const request = await raise({ priority: 'critical' });
    await breach(request.id);
    const escalated = await ok('POST', `/scientific-requests/${request.id}/escalate`, rep, {
      reason: 'Clinician has chased twice',
    });
    expect(escalated.escalationLevel).toBe(1);
    expect(escalated.escalatedBy).toBe(rep.userId);
    expect(escalated.escalationReason).toContain('chased');
  });

  it('an in-window request cannot be escalated', async () => {
    const request = await raise({ priority: 'routine' });
    const res = await call('POST', `/scientific-requests/${request.id}/escalate`, rep, {
      reason: 'Feels slow',
    });
    expect(res.statusCode).toBe(409);
  });

  it('a finished request cannot be escalated', async () => {
    const request = await raise();
    await ok('POST', `/scientific-requests/${request.id}/answer`, affairsA, {
      answerSummary: 'Reduce by one third.',
    });
    await breach(request.id);
    const res = await call('POST', `/scientific-requests/${request.id}/escalate`, rep, {
      reason: 'late',
    });
    expect(res.statusCode).toBe(409);
  });

  it('an escalation without a reason is refused', async () => {
    const request = await raise();
    await breach(request.id);
    const res = await call('POST', `/scientific-requests/${request.id}/escalate`, rep, {});
    expect(res.statusCode).toBe(400);
  });

  it('the database refuses an unevidenced escalation written directly', async () => {
    const request = await raise();
    await expect(
      getPool().query(`UPDATE scientific_request SET escalation_level = 1 WHERE id = $1`, [
        request.id,
      ]),
    ).rejects.toThrow();
  });

  it('a rep outside the HCP’s territory cannot escalate', async () => {
    const stranger = await makeUser(clinicId, 'ma-stranger', RoleKey.PHARMA_REP);
    const request = await raise();
    await breach(request.id);
    const res = await call('POST', `/scientific-requests/${request.id}/escalate`, stranger, {
      reason: 'late',
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('medical affairs — the queue and filters', () => {
  it('filters by assignee, category, priority and breach', async () => {
    const a = await raise({ inquiryCategory: 'safety', priority: 'critical' });
    await raise({ inquiryCategory: 'efficacy', priority: 'routine' });
    await ok('POST', `/scientific-requests/${a.id}/triage`, affairsA, {
      assignedTo: affairsB.userId,
    });
    await breach(a.id);

    const byCategory = await ok('GET', '/scientific-requests?inquiryCategory=safety', affairsA);
    expect(byCategory.results).toHaveLength(1);

    const mine = await ok('GET', '/scientific-requests?mine=true', affairsB);
    expect(mine.results.map((r: { id: string }) => r.id)).toEqual([a.id]);

    const breached = await ok('GET', '/scientific-requests?breachedOnly=true', affairsA);
    expect(breached.results.map((r: { id: string }) => r.id)).toEqual([a.id]);
  });

  it('the queue reports counts, never the enquiry text', async () => {
    const a = await raise({ inquiryCategory: 'safety' });
    await breach(a.id);
    const queue = await ok('GET', '/scientific-requests/queue', affairsA);
    expect(queue.unassigned).toBe(1);
    expect(queue.breached).toBe(1);
    expect(queue.byCategory.safety).toBe(1);
    expect(JSON.stringify(queue)).not.toContain('renal impairment');
  });

  it('the queue belongs to medical affairs, not to the field', async () => {
    const res = await call('GET', '/scientific-requests/queue', rep);
    expect(res.statusCode).toBe(403);
  });

  it('a representative only sees requests for HCPs in their territory', async () => {
    await raise();
    const stranger = await makeUser(clinicId, 'ma-stranger-2', RoleKey.PHARMA_REP);
    const body = await ok('GET', '/scientific-requests', stranger);
    expect(body.results).toEqual([]);
  });

  it('tenant isolation: another clinic’s request is never listed or readable', async () => {
    const request = await raise();
    const other = await makeClinic('Isolated MA Clinic');
    const outsider = await makeUser(other.clinicId, 'iso-affairs', RoleKey.MEDICAL_AFFAIRS);
    const body = await ok('GET', '/scientific-requests', outsider);
    expect(body.results).toEqual([]);
    const res = await call('GET', `/scientific-requests/${request.id}`, outsider);
    expect(res.statusCode).toBe(404);
  });

  it('every medical-affairs endpoint requires authentication', async () => {
    const request = await raise();
    for (const [method, url] of [
      ['POST', '/scientific-requests'],
      ['GET', '/scientific-requests'],
      ['GET', '/scientific-requests/queue'],
      ['GET', `/scientific-requests/${request.id}`],
      ['POST', `/scientific-requests/${request.id}/triage`],
      ['POST', `/scientific-requests/${request.id}/answer`],
      ['POST', `/scientific-requests/${request.id}/escalate`],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('a clinical role cannot reach any medical-affairs endpoint', async () => {
    const doctor = await makeUser(clinicId, 'ma-doctor', RoleKey.DOCTOR);
    const res = await call('GET', '/scientific-requests', doctor);
    expect(res.statusCode).toBe(403);
  });
});
