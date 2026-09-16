import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

let app: FastifyInstance;
let clinicId: string;
let author: TestUser;
let approver: TestUser;
let rep: TestUser;
let hcp: { id: string };
let territory: { id: string };

function auth(user: TestUser) {
  return { authorization: `Bearer ${user.token}` };
}

function isoDaysFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function createContent(overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/pharma/content',
    headers: auth(author),
    payload: {
      title: 'Dosing summary',
      contentType: 'faq',
      version: '1.0',
      jurisdiction: 'EG',
      ...overrides,
    },
  });
}

async function approve(contentId: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: `/pharma/content/${contentId}/decision`,
    headers: auth(approver),
    payload: { decision: 'approve', effectiveDate: isoDaysFromNow(-1), ...payload },
  });
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  author = await makeUser(clinicId, 'author', RoleKey.ADMIN);
  approver = await makeUser(clinicId, 'approver', RoleKey.ADMIN);
  rep = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);

  territory = (
    await app.inject({
      method: 'POST',
      url: '/territories',
      headers: auth(author),
      payload: { code: 'CAI', name: 'Cairo', country: 'EG' },
    })
  ).json();
  hcp = (
    await app.inject({
      method: 'POST',
      url: '/hcps',
      headers: auth(author),
      payload: { fullName: 'Dr Content Reader', professionalCategory: 'physician', provenance: { source: 'field_rep', jurisdiction: 'EG' } },
    })
  ).json();
  await app.inject({
    method: 'POST',
    url: `/territories/${territory.id}/targets`,
    headers: auth(author),
    payload: { hcpId: hcp.id },
  });
  await app.inject({
    method: 'POST',
    url: `/territories/${territory.id}/assignments`,
    headers: auth(author),
    payload: { userId: rep.userId },
  });
});

afterAll(async () => {
  if (app) await app.close();
});

describe('approved content — governance metadata is mandatory', () => {
  it('stores owner, version, jurisdiction and a draft approval state', async () => {
    const res = await createContent();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      version: '1.0',
      jurisdiction: 'EG',
      approvalStatus: 'draft',
      ownerUserId: author.userId,
      approvedBy: null,
    });
  });

  it('refuses content with no version', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pharma/content',
      headers: auth(author),
      payload: { title: 'Unversioned', contentType: 'faq', jurisdiction: 'EG' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a duplicate title+version+jurisdiction', async () => {
    await createContent();
    const res = await createContent();
    expect(res.statusCode).toBe(409);
  });

  it('refuses an expiry date before the effective date', async () => {
    const res = await createContent({
      effectiveDate: isoDaysFromNow(10),
      expiryDate: isoDaysFromNow(1),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('approved content — authoring and approval are separate', () => {
  it('a representative can neither author nor approve content', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/pharma/content',
      headers: auth(rep),
      payload: { title: 'Rep-made claim', contentType: 'faq', version: '1.0', jurisdiction: 'EG' },
    });
    expect(create.statusCode).toBe(403);

    const content = (await createContent()).json();
    const decide = await app.inject({
      method: 'POST',
      url: `/pharma/content/${content.id}/decision`,
      headers: auth(rep),
      payload: { decision: 'approve', effectiveDate: isoDaysFromNow(-1) },
    });
    expect(decide.statusCode).toBe(403);
  });

  it('the owner cannot approve their own content', async () => {
    const content = (await createContent()).json();
    const res = await app.inject({
      method: 'POST',
      url: `/pharma/content/${content.id}/decision`,
      headers: auth(author),
      payload: { decision: 'approve', effectiveDate: isoDaysFromNow(-1) },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/separate accountability/i);
  });

  it('approval records the approver and the time', async () => {
    const content = (await createContent()).json();
    const res = await approve(content.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ approvalStatus: 'approved', approvedBy: approver.userId });
    expect(res.json().approvedAt).not.toBeNull();
  });

  it('refuses approval without an effective date (no open-ended material)', async () => {
    const content = (await createContent()).json();
    const res = await app.inject({
      method: 'POST',
      url: `/pharma/content/${content.id}/decision`,
      headers: auth(approver),
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/effectiveDate/);
  });

  it('keeps an append-only history of every lifecycle decision', async () => {
    const content = (await createContent()).json();
    await approve(content.id);
    await app.inject({
      method: 'POST',
      url: `/pharma/content/${content.id}/decision`,
      headers: auth(approver),
      payload: { decision: 'withdraw', note: 'superseded by 1.1' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/pharma/content/${content.id}/history`,
      headers: auth(author),
    });
    expect(res.json().revisions.map((r: { changeType: string }) => r.changeType)).toEqual([
      'create',
      'approve',
      'withdraw',
    ]);
    await expect(
      getPool().query('DELETE FROM approved_content_revision'),
    ).rejects.toThrow(/append-only/);
  });
});

describe('approved content — the field only sees usable material', () => {
  it('a draft is invisible to a representative', async () => {
    const content = (await createContent()).json();
    const list = await app.inject({
      method: 'GET',
      url: '/pharma/content',
      headers: auth(rep),
    });
    expect(list.json().results).toEqual([]);

    const read = await app.inject({
      method: 'GET',
      url: `/pharma/content/${content.id}`,
      headers: auth(rep),
    });
    expect(read.statusCode).toBe(404);
  });

  it('expired content is gated out even though it was once approved', async () => {
    const content = (await createContent({ title: 'Expired leaflet' })).json();
    await approve(content.id, { effectiveDate: isoDaysFromNow(-30), expiryDate: isoDaysFromNow(-1) });

    const list = await app.inject({ method: 'GET', url: '/pharma/content', headers: auth(rep) });
    expect(list.json().results).toEqual([]);

    const read = await app.inject({
      method: 'GET',
      url: `/pharma/content/${content.id}`,
      headers: auth(rep),
    });
    expect(read.statusCode).toBe(404);
  });

  it('content not yet effective is gated out', async () => {
    const content = (await createContent({ title: 'Future launch aid' })).json();
    await approve(content.id, { effectiveDate: isoDaysFromNow(30) });
    const list = await app.inject({ method: 'GET', url: '/pharma/content', headers: auth(rep) });
    expect(list.json().results).toEqual([]);
  });

  it('approved, in-window content is visible to the field', async () => {
    const content = (await createContent({ title: 'Current detail aid' })).json();
    await approve(content.id, { effectiveDate: isoDaysFromNow(-1), expiryDate: isoDaysFromNow(30) });
    const list = await app.inject({ method: 'GET', url: '/pharma/content', headers: auth(rep) });
    expect(list.json().results.map((c: { id: string }) => c.id)).toEqual([content.id]);
  });
});

describe('approved content — engagement', () => {
  it('records that in-window content was presented to an HCP', async () => {
    const content = (await createContent({ title: 'Presented aid' })).json();
    await approve(content.id, { effectiveDate: isoDaysFromNow(-1) });

    const res = await app.inject({
      method: 'POST',
      url: `/pharma/content/${content.id}/engagements`,
      headers: auth(rep),
      payload: { hcpId: hcp.id, channel: 'in_person', engagementType: 'presented' },
    });
    expect(res.statusCode).toBe(201);

    const view = await app.inject({ method: 'GET', url: `/hcps/${hcp.id}`, headers: auth(rep) });
    expect(view.json().engagement.contentEngagement[0]).toMatchObject({
      contentId: content.id,
      engagementType: 'presented',
    });
  });

  it('REFUSES to record engagement with expired content', async () => {
    const content = (await createContent({ title: 'Stale aid' })).json();
    await approve(content.id, { effectiveDate: isoDaysFromNow(-30), expiryDate: isoDaysFromNow(-2) });

    const res = await app.inject({
      method: 'POST',
      url: `/pharma/content/${content.id}/engagements`,
      headers: auth(rep),
      payload: { hcpId: hcp.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/must not be used with an HCP/i);
  });

  it('refuses engagement against an out-of-territory HCP', async () => {
    const outsider = (
      await app.inject({
        method: 'POST',
        url: '/hcps',
        headers: auth(author),
        payload: { fullName: 'Dr Outsider', professionalCategory: 'physician', provenance: { source: 'field_rep', jurisdiction: 'EG' } },
      })
    ).json();
    const content = (await createContent({ title: 'Territory aid' })).json();
    await approve(content.id, { effectiveDate: isoDaysFromNow(-1) });

    const res = await app.inject({
      method: 'POST',
      url: `/pharma/content/${content.id}/engagements`,
      headers: auth(rep),
      payload: { hcpId: outsider.id },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('scientific answers must cite usable content', () => {
  it('refuses to cite content that is not approved', async () => {
    const content = (await createContent({ title: 'Draft answer source' })).json();
    const request = (
      await app.inject({
        method: 'POST',
        url: '/scientific-requests',
        headers: auth(rep),
        payload: { hcpId: hcp.id, question: 'What is the recommended titration schedule?' },
      })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: `/scientific-requests/${request.id}/answer`,
      headers: auth(approver),
      payload: { decision: 'answer', answerContentId: content.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/usable approved content/i);
  });

  it('accepts an answer citing approved, in-window content', async () => {
    const content = (await createContent({ title: 'Approved answer source' })).json();
    await approve(content.id, { effectiveDate: isoDaysFromNow(-1) });
    const request = (
      await app.inject({
        method: 'POST',
        url: '/scientific-requests',
        headers: auth(rep),
        payload: { hcpId: hcp.id, question: 'What is the recommended titration schedule?' },
      })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: `/scientific-requests/${request.id}/answer`,
      headers: auth(approver),
      payload: { decision: 'answer', answerContentId: content.id, answerSummary: 'See section 3.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().answerContentId).toBe(content.id);
  });
});

describe('segmentation and campaigns', () => {
  it('resolves a declarative segment and materialises campaign targets', async () => {
    const specialty = (
      await app.inject({
        method: 'POST',
        url: '/specialties',
        headers: auth(author),
        payload: { code: 'ENDO', displayName: 'Endocrinology', source: 'medcore_taxonomy' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/hcps/${hcp.id}/specialties`,
      headers: auth(author),
      payload: { specialtyId: specialty.id, isPrimary: true, source: 'field_rep' },
    });

    const segment = (
      await app.inject({
        method: 'POST',
        url: '/pharma/segments',
        headers: auth(author),
        payload: {
          key: 'ENDO_CAIRO',
          name: 'Endocrinologists in Cairo',
          definition: { specialtyIds: [specialty.id], territoryIds: [territory.id] },
        },
      })
    ).json();

    const resolved = await app.inject({
      method: 'POST',
      url: `/pharma/segments/${segment.id}/resolve`,
      headers: auth(author),
    });
    expect(resolved.json().matched).toBe(1);

    const campaign = (
      await app.inject({
        method: 'POST',
        url: '/pharma/campaigns',
        headers: auth(author),
        payload: {
          code: 'Q1-LAUNCH',
          name: 'Q1 launch',
          jurisdiction: 'EG',
          segmentId: segment.id,
        },
      })
    ).json();

    const targets = await app.inject({
      method: 'POST',
      url: `/pharma/campaigns/${campaign.id}/targets`,
      headers: auth(author),
    });
    expect(targets.json().targetsAdded).toBe(1);

    const list = await app.inject({
      method: 'GET',
      url: '/pharma/campaigns',
      headers: auth(author),
    });
    expect(list.json().results[0]).toMatchObject({ code: 'Q1-LAUNCH', targets: 1 });
  });

  it('a representative can read segments but not define them', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/pharma/segments',
      headers: auth(rep),
      payload: { key: 'MINE', name: 'Mine' },
    });
    expect(create.statusCode).toBe(403);

    const list = await app.inject({
      method: 'GET',
      url: '/pharma/segments',
      headers: auth(rep),
    });
    expect(list.statusCode).toBe(200);
  });

  it('refuses to derive targets for a campaign with no segment', async () => {
    const campaign = (
      await app.inject({
        method: 'POST',
        url: '/pharma/campaigns',
        headers: auth(author),
        payload: { code: 'NOSEG', name: 'No segment', jurisdiction: 'EG' },
      })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/pharma/campaigns/${campaign.id}/targets`,
      headers: auth(author),
    });
    expect(res.statusCode).toBe(400);
  });
});
