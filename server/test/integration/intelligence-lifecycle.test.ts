import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { ABSOLUTE_MIN_COHORT } from '../../src/modules/intelligence/firewall.js';

/**
 * THE GOVERNED SIGNAL LIFECYCLE (migration 0311).
 *
 * Before this, a firewall run published its own output the instant it was
 * computed: the arithmetic was reviewed, the CLAIM never was, and there was no
 * way to retract or expire one. These tests pin the behaviour change — nothing
 * is published by being computed — and the four rules that hold it up.
 */

let app: FastifyInstance;
let clinicId: string;
let producer: TestUser;   // runs the pipeline
let reviewer: TestUser;   // a SECOND governance principal
let steward: TestUser;
let rep: TestUser;        // a consumer: intelligence:signal-read only
let territoryId: string;

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const PROV = { source: 'field_rep', jurisdiction: 'EG' };
const TODAY = new Date().toISOString().slice(0, 10);
const WEEK_AGO = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
})();

async function call(
  method: 'GET' | 'POST',
  url: string,
  user: TestUser,
  payload?: Record<string, unknown>,
) {
  return app.inject({ method, url, headers: auth(user), ...(payload ? { payload } : {}) });
}

async function ok(
  method: 'GET' | 'POST',
  url: string,
  user: TestUser,
  payload?: Record<string, unknown>,
) {
  const res = await call(method, url, user, payload);
  if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
  return res.json();
}

/** Seed a cohort large enough to survive the firewall threshold. */
async function seedCohort(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const hcp = await ok('POST', '/hcps', steward, {
      fullName: `Dr Cohort ${i}`,
      professionalCategory: 'physician',
      provenance: PROV,
    });
    await ok('POST', `/territories/${territoryId}/targets`, producer, { hcpId: hcp.id });
    const visit = await ok('POST', '/visits', rep, {
      hcpId: hcp.id,
      plannedAt: new Date().toISOString(),
    });
    await ok('POST', `/visits/${visit.id}/call-report`, rep, {
      summary: 'Routine detail call',
      objections: [{ objectionType: 'cost', objectionText: 'Raised a concern' }],
    });
  }
}

async function runPipeline(as: TestUser = producer) {
  return ok('POST', '/intelligence/runs', as, {
    sourceKind: 'pharma_field',
    signalType: 'hcp_feedback_theme',
    periodStart: WEEK_AGO,
    periodEnd: TODAY,
    jurisdiction: 'EG',
    scopeType: 'territory',
    aggregationLevel: 'territory',
  });
}

/** Produce one draft signal and return its id. */
async function draftSignal(): Promise<string> {
  await seedCohort(ABSOLUTE_MIN_COHORT + 2);
  const outcome = await runPipeline();
  expect(outcome.signals.length).toBeGreaterThan(0);
  return outcome.signals[0].id as string;
}

function decide(id: string, body: Record<string, unknown>, as: TestUser = reviewer) {
  return call('POST', `/intelligence/signals/${id}/decision`, as, body);
}

async function publishThroughReview(id: string, validForDays?: number) {
  await ok('POST', `/intelligence/signals/${id}/decision`, reviewer, {
    decision: 'submit_review',
  });
  await ok('POST', `/intelligence/signals/${id}/decision`, reviewer, { decision: 'approve' });
  return decide(id, {
    decision: 'publish',
    ...(validForDays !== undefined ? { validForDays } : {}),
  });
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  producer = await makeUser(clinicId, 'sig-producer', RoleKey.PHARMA_MANAGER);
  reviewer = await makeUser(clinicId, 'sig-reviewer', RoleKey.PHARMA_MANAGER);
  steward = await makeUser(clinicId, 'sig-steward', RoleKey.PHARMA_DATA_STEWARD);
  rep = await makeUser(clinicId, 'sig-rep', RoleKey.PHARMA_REP);

  const territory = await ok('POST', '/territories', producer, {
    code: 'N',
    name: 'North',
    country: 'EG',
  });
  territoryId = territory.id;
  await ok('POST', `/territories/${territoryId}/assignments`, producer, { userId: rep.userId });
});

afterAll(async () => {
  if (app) await app.close();
});

describe('nothing is published by being computed', () => {
  it('a firewall run produces DRAFTS', async () => {
    const id = await draftSignal();
    const signal = await ok('GET', `/intelligence/signals/${id}`, producer);
    expect(signal.lifecycleStatus).toBe('draft');
    expect(signal.publishedAt).toBeNull();
  });

  it('a consumer sees nothing until a claim is published', async () => {
    const id = await draftSignal();
    const before = await ok('GET', '/intelligence/signals', rep);
    expect(before.signals).toEqual([]);

    await publishThroughReview(id);
    const after = await ok('GET', '/intelligence/signals', rep);
    expect(after.signals.map((s: { id: string }) => s.id)).toContain(id);
  });

  it('to a consumer an unpublished signal does not exist, rather than being forbidden', async () => {
    const id = await draftSignal();
    const res = await call('GET', `/intelligence/signals/${id}`, rep);
    expect(res.statusCode).toBe(404);
  });

  it('a consumer asking for drafts is REFUSED, not handed an empty list', async () => {
    await draftSignal();
    const res = await call('GET', '/intelligence/signals?lifecycleStatus=draft', rep);
    expect(res.statusCode).toBe(403);
  });

  it('a governance principal can see the pipeline’s drafts', async () => {
    const id = await draftSignal();
    const body = await ok('GET', '/intelligence/signals?lifecycleStatus=draft', producer);
    expect(body.signals.map((s: { id: string }) => s.id)).toContain(id);
  });
});

describe('the review path', () => {
  it('a draft cannot be published directly', async () => {
    const id = await draftSignal();
    const res = await decide(id, { decision: 'publish' });
    expect(res.statusCode).toBe(409);
  });

  it('a draft cannot be approved without review', async () => {
    const id = await draftSignal();
    const res = await decide(id, { decision: 'approve' });
    expect(res.statusCode).toBe(409);
  });

  it('review, approve, publish records who did what', async () => {
    const id = await draftSignal();
    const published = (await publishThroughReview(id)).json();
    expect(published.lifecycleStatus).toBe('published');
    expect(published.approvedBy).toBe(reviewer.userId);
    expect(published.publishedBy).toBe(reviewer.userId);
    expect(published.publishedAt).not.toBeNull();
    expect(published.expiresAt).not.toBeNull();
  });

  it('a rejection needs a reason and keeps it', async () => {
    const id = await draftSignal();
    await ok('POST', `/intelligence/signals/${id}/decision`, reviewer, {
      decision: 'submit_review',
    });
    const bare = await decide(id, { decision: 'reject' });
    expect(bare.statusCode).toBe(400);
    const rejected = (
      await decide(id, { decision: 'reject', reason: 'Denominator covers the wrong period' })
    ).json();
    expect(rejected.lifecycleStatus).toBe('rejected');
    expect(rejected.reviewNote).toContain('wrong period');
  });

  it('a rejected claim re-enters at review, never at approved', async () => {
    const id = await draftSignal();
    await ok('POST', `/intelligence/signals/${id}/decision`, reviewer, {
      decision: 'submit_review',
    });
    await ok('POST', `/intelligence/signals/${id}/decision`, reviewer, {
      decision: 'reject',
      reason: 'Wrong denominator',
    });
    expect((await decide(id, { decision: 'approve' })).statusCode).toBe(409);
    expect(
      (await decide(id, { decision: 'submit_review' })).statusCode,
    ).toBe(200);
  });

  it('re-entering review clears the previous approval', async () => {
    const id = await draftSignal();
    await publishThroughReview(id);
    await ok('POST', `/intelligence/signals/${id}/decision`, reviewer, {
      decision: 'withdraw',
      reason: 'Superseded by a corrected run',
    });
    const back = (await decide(id, { decision: 'submit_review' })).json();
    expect(back.approvedBy).toBeNull();
    expect(back.approvedAt).toBeNull();
  });
});

describe('separation of duties', () => {
  it('the principal whose run produced a signal cannot approve it', async () => {
    const id = await draftSignal();
    await ok('POST', `/intelligence/signals/${id}/decision`, producer, {
      decision: 'submit_review',
    });
    const res = await decide(id, { decision: 'approve' }, producer);
    expect(res.statusCode).toBe(409);
    expect((await decide(id, { decision: 'approve' }, reviewer)).statusCode).toBe(200);
  });

  it('publishing an already-approved claim is not itself an approval', async () => {
    const id = await draftSignal();
    await ok('POST', `/intelligence/signals/${id}/decision`, producer, {
      decision: 'submit_review',
    });
    await ok('POST', `/intelligence/signals/${id}/decision`, reviewer, { decision: 'approve' });
    // The producer may operate the publish step: the acceptance was somebody else's.
    const res = await decide(id, { decision: 'publish' }, producer);
    expect(res.statusCode).toBe(200);
  });

  it('the database refuses a self-approval written directly', async () => {
    const id = await draftSignal();
    await expect(
      getPool().query(
        `UPDATE aggregated_signal
            SET approved_by = generated_by, approved_at = now()
          WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow();
  });

  it('a consumer cannot make any lifecycle decision', async () => {
    const id = await draftSignal();
    const res = await decide(id, { decision: 'submit_review' }, rep);
    expect(res.statusCode).toBe(403);
  });
});

describe('retraction and expiry', () => {
  it('a published claim can be withdrawn, with a reason', async () => {
    const id = await draftSignal();
    await publishThroughReview(id);
    const bare = await decide(id, { decision: 'withdraw' });
    expect(bare.statusCode).toBe(400);
    const withdrawn = (
      await decide(id, { decision: 'withdraw', reason: 'Objection theme misread as a trend' })
    ).json();
    expect(withdrawn.lifecycleStatus).toBe('withdrawn');
    expect(withdrawn.withdrawalReason).toContain('misread');
    const consumerView = await ok('GET', '/intelligence/signals', rep);
    expect(consumerView.signals).toEqual([]);
  });

  it('expiry is DERIVED: a lapsed claim leaves the consumer view before any sweep', async () => {
    const id = await draftSignal();
    await publishThroughReview(id);
    await getPool().query(
      `UPDATE aggregated_signal SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    const consumerView = await ok('GET', '/intelligence/signals', rep);
    expect(consumerView.signals).toEqual([]);
    const governanceView = await ok('GET', '/intelligence/signals?lifecycleStatus=expired', producer);
    expect(governanceView.signals.map((s: { id: string }) => s.id)).toContain(id);
  });

  it('the sweep persists the lapse and is idempotent', async () => {
    const id = await draftSignal();
    await publishThroughReview(id);
    await getPool().query(
      `UPDATE aggregated_signal SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    const first = await ok('POST', '/intelligence/signals/expiry-sweep', producer, {});
    expect(first.expired).toBe(1);
    const second = await ok('POST', '/intelligence/signals/expiry-sweep', producer, {});
    expect(second.expired).toBe(0);
    const signal = await ok('GET', `/intelligence/signals/${id}`, producer);
    expect(signal.lifecycleStatus).toBe('expired');
  });

  it('an expired claim cannot be re-published without a fresh review', async () => {
    const id = await draftSignal();
    await publishThroughReview(id);
    await getPool().query(
      `UPDATE aggregated_signal SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    expect((await decide(id, { decision: 'publish' })).statusCode).toBe(409);
    expect((await decide(id, { decision: 'submit_review' })).statusCode).toBe(200);
  });

  it('a shorter shelf life may be chosen; an unbounded one may not be implied', async () => {
    const id = await draftSignal();
    const published = (await publishThroughReview(id, 7)).json();
    const days =
      (new Date(published.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeLessThan(8);
    expect(days).toBeGreaterThan(6);
  });
});

describe('re-running the pipeline', () => {
  it('a re-computed signal returns to draft and loses its approval', async () => {
    const id = await draftSignal();
    await publishThroughReview(id);
    // The same slice again: the upsert lands on the same row.
    await runPipeline();
    const signal = await ok('GET', `/intelligence/signals/${id}`, producer);
    expect(signal.lifecycleStatus).toBe('draft');
    expect(signal.approvedBy).toBeNull();
    expect(signal.publishedAt).toBeNull();
    const consumerView = await ok('GET', '/intelligence/signals', rep);
    expect(consumerView.signals).toEqual([]);
  });
});

describe('the decision trail (0314 audit)', () => {
  it('a run records the generation of a draft, attributed to whoever ran it', async () => {
    const id = await draftSignal();
    const body = await ok('GET', `/intelligence/signals/${id}/history`, producer);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      eventType: 'generated',
      fromStatus: null,
      toStatus: 'draft',
      actorId: producer.userId,
    });
  });

  it('every decision lands in the trail, in order, with its actor', async () => {
    const id = await draftSignal();
    await publishThroughReview(id);
    const body = await ok('GET', `/intelligence/signals/${id}/history`, producer);
    expect(body.events.map((e: { eventType: string }) => e.eventType)).toEqual([
      'generated',
      'submitted',
      'approved',
      'published',
    ]);
    for (const event of body.events.slice(1)) {
      expect(event.actorId).toBe(reviewer.userId);
    }
  });

  it('a withdrawal records its reason in the trail', async () => {
    const id = await draftSignal();
    await publishThroughReview(id);
    await ok('POST', `/intelligence/signals/${id}/decision`, reviewer, {
      decision: 'withdraw',
      reason: 'Objection theme misread as a trend',
    });
    const body = await ok('GET', `/intelligence/signals/${id}/history`, producer);
    const withdrawal = body.events.at(-1);
    expect(withdrawal.eventType).toBe('withdrawn');
    expect(withdrawal.reason).toContain('misread');
  });

  it('WHO put the claim into review is recorded — those columns were dead', async () => {
    const id = await draftSignal();
    await ok('POST', `/intelligence/signals/${id}/decision`, reviewer, {
      decision: 'submit_review',
    });
    const signal = await ok('GET', `/intelligence/signals/${id}`, producer);
    expect(signal.reviewedBy).toBe(reviewer.userId);
    expect(signal.reviewedAt).not.toBeNull();
  });

  it('a withdrawal is NOT erased by re-submitting the claim for review', async () => {
    const id = await draftSignal();
    await publishThroughReview(id);
    await ok('POST', `/intelligence/signals/${id}/decision`, reviewer, {
      decision: 'withdraw',
      reason: 'Superseded by a corrected run',
    });
    const back = await ok('POST', `/intelligence/signals/${id}/decision`, reviewer, {
      decision: 'submit_review',
    });
    // Why a live claim was pulled matters most exactly when someone reopens it.
    expect(back.withdrawalReason).toContain('corrected run');
    expect(back.withdrawnBy).toBe(reviewer.userId);
  });

  it('an expiry is recorded per signal and attributed to NOBODY', async () => {
    const id = await draftSignal();
    await publishThroughReview(id);
    await getPool().query(
      `UPDATE aggregated_signal SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    await ok('POST', '/intelligence/signals/expiry-sweep', producer, {});
    const body = await ok('GET', `/intelligence/signals/${id}/history`, producer);
    const expiry = body.events.at(-1);
    expect(expiry.eventType).toBe('expired');
    expect(expiry.fromStatus).toBe('published');
    expect(expiry.toStatus).toBe('expired');
    // The system observed a clock; the person who ran the sweep decided nothing.
    expect(expiry.actorId).toBeNull();
  });

  it('a re-run records the SUPERSESSION of the claim it replaced', async () => {
    const id = await draftSignal();
    await publishThroughReview(id);
    await runPipeline();
    const body = await ok('GET', `/intelligence/signals/${id}/history`, producer);
    const superseded = body.events.at(-1);
    expect(superseded.eventType).toBe('superseded');
    expect(superseded.fromStatus).toBe('published');
    expect(superseded.toStatus).toBe('draft');
  });

  it('the trail cannot be edited or erased', async () => {
    const id = await draftSignal();
    await expect(
      getPool().query(`UPDATE aggregated_signal_event SET reason = 'x' WHERE signal_id = $1`, [id]),
    ).rejects.toThrow();
    await expect(
      getPool().query(`DELETE FROM aggregated_signal_event WHERE signal_id = $1`, [id]),
    ).rejects.toThrow();
  });

  it('the database refuses an unexplained refusal in the trail', async () => {
    const id = await draftSignal();
    await expect(
      getPool().query(
        `INSERT INTO aggregated_signal_event
           (clinic_id, signal_id, event_type, from_status, to_status)
         VALUES ($1, $2, 'withdrawn', 'published', 'withdrawn')`,
        [clinicId, id],
      ),
    ).rejects.toThrow();
  });

  it('the trail never carries the claim’s value or cohort size', async () => {
    const id = await draftSignal();
    await publishThroughReview(id);
    const { rows } = await getPool().query<{ detail: unknown; reason: string | null }>(
      `SELECT detail, reason FROM aggregated_signal_event WHERE signal_id = $1`,
      [id],
    );
    for (const row of rows) {
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain('cohortSize');
      expect(serialized).not.toContain('cohort_size');
      expect(serialized).not.toContain('"value"');
    }
  });

  it('the trail belongs to governance, not to a consumer', async () => {
    const id = await draftSignal();
    await publishThroughReview(id);
    const res = await call('GET', `/intelligence/signals/${id}/history`, rep);
    expect(res.statusCode).toBe(403);
  });

  it('another clinic cannot read the trail', async () => {
    const id = await draftSignal();
    const other = await makeClinic('Other Trail Clinic');
    const outsider = await makeUser(other.clinicId, 'trail-mgr', RoleKey.PHARMA_MANAGER);
    const res = await call('GET', `/intelligence/signals/${id}/history`, outsider);
    expect(res.statusCode).toBe(404);
  });

  it('the trail endpoint requires authentication', async () => {
    const id = await draftSignal();
    const res = await app.inject({ method: 'GET', url: `/intelligence/signals/${id}/history` });
    expect(res.statusCode).toBe(401);
  });
});

describe('governance boundaries hold', () => {
  it('a lifecycle decision never carries the signal’s value into an event', async () => {
    const id = await draftSignal();
    await publishThroughReview(id);
    const { rows } = await getPool().query<{ payload: unknown }>(
      `SELECT payload FROM event WHERE type = 'INTELLIGENCE_SIGNAL_LIFECYCLE_CHANGED'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const serialized = JSON.stringify(row.payload);
      expect(serialized).not.toContain('cohortSize');
      expect(serialized).not.toContain('"value"');
    }
  });

  it('tenant isolation: another clinic cannot see or decide on this signal', async () => {
    const id = await draftSignal();
    const other = await makeClinic('Other Signal Clinic');
    const outsider = await makeUser(other.clinicId, 'iso-mgr', RoleKey.PHARMA_MANAGER);
    expect((await call('GET', `/intelligence/signals/${id}`, outsider)).statusCode).toBe(404);
    expect((await decide(id, { decision: 'submit_review' }, outsider)).statusCode).toBe(404);
  });

  it('every lifecycle endpoint requires authentication', async () => {
    const id = await draftSignal();
    for (const [method, url] of [
      ['GET', `/intelligence/signals/${id}`],
      ['POST', `/intelligence/signals/${id}/decision`],
      ['POST', '/intelligence/signals/expiry-sweep'],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('a draft never reaches a governed export', async () => {
    const id = await draftSignal();
    const beforePublish = await ok('POST', '/pharma/reports/intelligence_signals', producer, {});
    expect(beforePublish.rows).toEqual([]);
    await publishThroughReview(id);
    const afterPublish = await ok('POST', '/pharma/reports/intelligence_signals', producer, {});
    expect(afterPublish.rows.length).toBeGreaterThan(0);
  });
});
