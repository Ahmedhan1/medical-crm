import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { ABSOLUTE_MIN_COHORT } from '../../src/modules/intelligence/firewall.js';

/**
 * PHASE 58 — PHI / disclosure RED TEAM.
 *
 * These tests attack the intelligence layer rather than exercising it. Each one
 * is an attempt to recover something about an individual that the minimum-cohort
 * threshold alone does not stop, and each must fail closed.
 *
 * The first two encode a leak that was verified against the running system
 * before the Phase 28/29 controls existed: exact cohort sizes were published and
 * narrowing runs were unlimited, so an analyst could subtract their way down to
 * a below-threshold cohort.
 */

let app: FastifyInstance;
let clinicId: string;
let manager: TestUser;
/** A SECOND governance principal: a signal may not be approved by whoever generated it. */
let signalReviewer: TestUser;
let steward: TestUser;
let rep: TestUser;
let north: { id: string };
let south: { id: string };

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const PROV = { source: 'field_rep', jurisdiction: 'EG' };
const TODAY = new Date().toISOString().slice(0, 10);
/** A week-wide window, so a narrowing chain has room to narrow the PERIOD too. */
const WEEK_AGO = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
})();

async function territory(code: string, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/territories',
    headers: auth(manager),
    payload: { code, name, country: 'EG' },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/** Seed `count` HCPs in `territoryId`, each raising one objection of `type`. */
async function seedCohort(count: number, type: string, territoryId: string, tag = '') {
  for (let i = 0; i < count; i += 1) {
    const hcp = (
      await app.inject({
        method: 'POST',
        url: '/hcps',
        headers: auth(steward),
        payload: { fullName: `Dr ${type}${tag} ${i}`, professionalCategory: 'physician', provenance: PROV },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/territories/${territoryId}/targets`,
      headers: auth(manager),
      payload: { hcpId: hcp.id },
    });
    const visit = (
      await app.inject({
        method: 'POST',
        url: '/visits',
        headers: auth(rep),
        payload: { hcpId: hcp.id, plannedAt: new Date().toISOString() },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/visits/${visit.id}/call-report`,
      headers: auth(rep),
      payload: {
        summary: 'Routine detail call',
        objections: [{ objectionType: type, objectionText: 'Raised a concern' }],
      },
    });
  }
}

/**
 * A firewall run now produces DRAFTS (migration 0311): nothing is published by
 * being computed. These suites are about the firewall and disclosure control,
 * so they drive every draft the run produced through review, approval and
 * publication — by a SECOND principal, because a signal may not be approved by
 * whoever generated it.
 */
async function publishAllSignals(): Promise<void> {
  const drafts = await app.inject({
    method: 'GET',
    url: '/intelligence/signals?lifecycleStatus=draft',
    headers: auth(manager),
  });
  for (const signal of drafts.json().signals as Array<{ id: string }>) {
    for (const decision of ['submit_review', 'approve', 'publish']) {
      const res = await app.inject({
        method: 'POST',
        url: `/intelligence/signals/${signal.id}/decision`,
        headers: auth(signalReviewer),
        payload: { decision },
      });
      if (res.statusCode >= 400) {
        throw new Error(`decision ${decision} -> ${res.statusCode} ${res.body}`);
      }
    }
  }
}

function runRaw(overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/intelligence/runs',
    headers: auth(manager),
    payload: {
      sourceKind: 'pharma_field',
      signalType: 'hcp_feedback_theme',
      periodStart: WEEK_AGO,
      periodEnd: TODAY,
      jurisdiction: 'EG',
      scopeType: 'territory',
      aggregationLevel: 'territory',
      ...overrides,
    },
  });
}

/** Run the pipeline, then publish whatever it drafted. */
async function run(overrides: Record<string, unknown> = {}) {
  const res = await runRaw(overrides);
  if (res.statusCode < 400) await publishAllSignals();
  return res;
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  // Least privilege means the attack needs three different principals to even
  // set up: only the steward may create HCPs, only the manager may target and
  // publish, only the rep may report a visit.
  manager = await makeUser(clinicId, 'mgr', RoleKey.PHARMA_MANAGER);
  signalReviewer = await makeUser(clinicId, 'signal-reviewer', RoleKey.PHARMA_MANAGER);
  steward = await makeUser(clinicId, 'stw', RoleKey.PHARMA_DATA_STEWARD);
  rep = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
  north = await territory('CAI-N', 'Cairo North');
  south = await territory('CAI-S', 'Cairo South');
  for (const t of [north, south]) {
    await app.inject({
      method: 'POST',
      url: `/territories/${t.id}/assignments`,
      headers: auth(manager),
      payload: { userId: rep.userId },
    });
  }
});

afterAll(async () => {
  if (app) await app.close();
});

describe('red team — exact cohort sizes are not published', () => {
  it('a published signal carries a BAND, never an exact count', async () => {
    await seedCohort(7, 'safety', north.id);
    const outcome = (await run()).json();
    const signal = outcome.signals[0];

    expect(signal.cohortBand).toBe('5-9');
    // The exact 7 is the raw material of a differencing attack; it must not be
    // anywhere in the response body.
    expect(signal.cohortSize).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toContain('"cohortSize"');
  });

  it('the exact count is still stored for the operator audit trail', async () => {
    await seedCohort(7, 'safety', north.id);
    await run();
    const { rows } = await getPool().query<{ cohort_size: number; cohort_band: string }>(
      'SELECT cohort_size, cohort_band FROM aggregated_signal',
    );
    expect(rows[0]).toMatchObject({ cohort_size: 7, cohort_band: '5-9' });
  });

  it('the measurement is rounded, so a one-subject delta is not observable', async () => {
    await seedCohort(7, 'safety', north.id);
    const outcome = (await run()).json();
    // 7 observations round to 5 under the default base of 5.
    expect(outcome.signals[0].value).toBe(5);
    expect(outcome.signals[0].valueRoundingBase).toBe(5);
  });

  it('the read API also bands, not just the run receipt', async () => {
    await seedCohort(7, 'safety', north.id);
    await run();
    const read = await app.inject({
      method: 'GET',
      url: '/intelligence/signals',
      headers: auth(rep),
    });
    expect(read.json().signals[0].cohortBand).toBe('5-9');
    expect(read.body).not.toContain('"cohortSize"');
  });
});

describe('red team — complementary suppression', () => {
  it('withholds a second cohort so a lone suppressed one cannot be subtracted out', async () => {
    // One large cohort, one medium, and one below threshold. Publishing both
    // survivors alongside a single hidden cell would let the hidden cell be
    // recovered from a known total.
    await seedCohort(12, 'safety', north.id);
    await seedCohort(6, 'efficacy', north.id);
    await seedCohort(2, 'cost', north.id);

    const outcome = (await run()).json();
    const keys = outcome.signals.map((s: { signalKey: string }) => s.signalKey);

    expect(keys).toContain('safety');
    expect(keys).not.toContain('cost'); // below threshold
    expect(keys).not.toContain('efficacy'); // withheld to protect 'cost'
    expect(outcome.cohortsSuppressed).toBe(2);
  });
});

describe('red team — differencing by repeated narrowing', () => {
  it('REFUSES a narrowing chain before it can isolate a subject', async () => {
    await seedCohort(8, 'safety', north.id);
    await seedCohort(6, 'safety', south.id, '-s');

    // 1. the whole clinic — allowed
    expect((await run()).statusCode).toBe(201);
    // 2. both territories named explicitly — allowed (depth 1)
    expect((await run({ territoryIds: [north.id, south.id] })).statusCode).toBe(201);
    // 3. one territory — allowed (depth 2, the permitted limit)
    expect((await run({ territoryIds: [north.id] })).statusCode).toBe(201);

    // 4. the same territory over a SHORTER period — depth 3, refused. This is
    //    the step that would start isolating individual contributions.
    const attack = await run({ territoryIds: [north.id], periodStart: TODAY, periodEnd: TODAY });
    expect(attack.statusCode).toBe(429);
    expect(attack.json().error.code).toBe('intelligence_query_governance');
    expect(attack.json().error.details.control).toBe('denied_narrowing');
    expect(attack.json().error.details.narrowingDepth).toBeGreaterThan(2);
  });

  it('a refused narrowing run publishes nothing and computes nothing', async () => {
    await seedCohort(8, 'safety', north.id);
    await run();
    await run({ territoryIds: [north.id, south.id] });
    await run({ territoryIds: [north.id] });
    const before = await getPool().query('SELECT count(*)::int AS n FROM intelligence_run');

    const attack = await run({ territoryIds: [north.id], periodStart: TODAY, periodEnd: TODAY });
    expect(attack.statusCode).toBe(429);

    // No run row was created: the answer was never computed, not computed and
    // withheld.
    const after = await getPool().query('SELECT count(*)::int AS n FROM intelligence_run');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('records the refusal in an append-only log the prober cannot erase', async () => {
    await seedCohort(8, 'safety', north.id);
    await run();
    await run({ territoryIds: [north.id, south.id] });
    await run({ territoryIds: [north.id] });
    await run({ territoryIds: [north.id], periodStart: TODAY, periodEnd: TODAY });

    const { rows } = await getPool().query<{ outcome: string; narrowing_depth: number }>(
      `SELECT outcome, narrowing_depth FROM intelligence_query_log
        WHERE outcome <> 'allowed' ORDER BY id`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.outcome).toBe('denied_narrowing');

    await expect(getPool().query('DELETE FROM intelligence_query_log')).rejects.toThrow(
      /append-only/,
    );
    await expect(
      getPool().query(`UPDATE intelligence_query_log SET outcome = 'allowed'`),
    ).rejects.toThrow(/append-only/);
  });

  it('a refused attempt does not deepen the chain (no self-inflicted lockout)', async () => {
    await seedCohort(8, 'safety', north.id);
    await run();
    await run({ territoryIds: [north.id, south.id] });
    await run({ territoryIds: [north.id] });

    // Two refusals in a row …
    const narrow = { territoryIds: [north.id], periodStart: TODAY, periodEnd: TODAY };
    expect((await run(narrow)).statusCode).toBe(429);
    expect((await run(narrow)).statusCode).toBe(429);

    // … and a legitimately WIDE query still works: refusals were not counted
    // into the narrowing history.
    const wide = await run({ territoryIds: [north.id, south.id] });
    expect(wide.statusCode).toBe(201);
  });
});

describe('red team — query budget', () => {
  it('exhausts the budget and then refuses, naming the control', async () => {
    await seedCohort(8, 'safety', north.id);
    await app.inject({
      method: 'PUT',
      url: '/intelligence/policies',
      headers: auth(manager),
      payload: {
        key: 'tight',
        description: 'Tight budget for the red-team test',
        jurisdiction: 'EG',
        minCohortSize: ABSOLUTE_MIN_COHORT,
        maxQueriesPerWindow: 3,
        maxNarrowingDepth: 10,
      },
    });

    for (let i = 0; i < 3; i += 1) {
      expect((await run({ policyKey: 'tight' })).statusCode).toBe(201);
    }
    const refused = await run({ policyKey: 'tight' });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.details.control).toBe('denied_budget');
    expect(refused.json().error.details.maxQueriesPerWindow).toBe(3);
  });

  it('reports the caller their own budget position so they need not probe for it', async () => {
    await seedCohort(8, 'safety', north.id);
    await run();
    const res = await app.inject({
      method: 'GET',
      url: '/intelligence/query-budget',
      headers: auth(manager),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      maxQueriesPerWindow: 30,
      windowHours: 24,
      used: 1,
      remaining: 29,
      maxNarrowingDepth: 2,
    });
  });

  it('a representative cannot read the budget (it is a publisher-only surface)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/intelligence/query-budget',
      headers: auth(rep),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('red team — the controls cannot be configured away', () => {
  it('refuses a policy that tries to buy an unlimited budget', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/intelligence/policies',
      headers: auth(manager),
      payload: {
        key: 'unbounded',
        description: 'attempt',
        jurisdiction: 'EG',
        minCohortSize: ABSOLUTE_MIN_COHORT,
        maxQueriesPerWindow: 100000,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('the database refuses complementary suppression being switched off', async () => {
    await expect(
      getPool().query(
        `INSERT INTO intelligence_policy
           (clinic_id, key, description, jurisdiction, complementary_suppression)
         VALUES ($1,'off','attempt','EG', false)`,
        [clinicId],
      ),
    ).rejects.toThrow(/complementary_suppression/);
  });

  it('the database refuses a zero or negative query budget', async () => {
    await expect(
      getPool().query(
        `INSERT INTO intelligence_policy
           (clinic_id, key, description, jurisdiction, max_queries_per_window)
         VALUES ($1,'zero','attempt','EG', 0)`,
        [clinicId],
      ),
    ).rejects.toThrow(/max_queries_per_window/);
  });

  it('a representative cannot publish, so cannot drive the pipeline at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/intelligence/runs',
      headers: auth(rep),
      payload: {
        signalType: 'hcp_feedback_theme',
        periodStart: TODAY,
        periodEnd: TODAY,
        jurisdiction: 'EG',
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('red team — the query log holds no patient or subject data', () => {
  it('records only the shape of a request', async () => {
    await seedCohort(8, 'safety', north.id);
    await run();
    const { rows } = await getPool().query<Record<string, unknown>>(
      'SELECT * FROM intelligence_query_log LIMIT 1',
    );
    const entry = rows[0]!;
    // Territory ids are commercial geography, not subjects.
    expect(Object.keys(entry)).not.toContain('subject_id');
    expect(Object.keys(entry)).not.toContain('patient_id');
    expect(Object.keys(entry)).not.toContain('hcp_id');
    expect(JSON.stringify(entry)).not.toContain('Dr safety');
  });
});


// ---------------------------------------------------------------------------
// PHASE 27 (safety) — there is no adverse-event pipeline yet, and no covert one.
//
// CCR-007 proposes the governed handoff; until it is approved these tests pin
// the CURRENT, deliberate absence, so a future change cannot quietly introduce a
// clinical workflow inside the pharma layer without failing here.
// ---------------------------------------------------------------------------
describe('red team — no covert safety or clinical workflow exists', () => {
  it('a safety objection is commercial data, with no clinical linkage', async () => {
    const hcp = (
      await app.inject({
        method: 'POST',
        url: '/hcps',
        headers: auth(steward),
        payload: {
          fullName: 'Dr Safety Theme',
          professionalCategory: 'physician',
          provenance: PROV,
        },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/territories/${north.id}/targets`,
      headers: auth(manager),
      payload: { hcpId: hcp.id },
    });
    const visit = (
      await app.inject({
        method: 'POST',
        url: '/visits',
        headers: auth(rep),
        payload: { hcpId: hcp.id, plannedAt: new Date().toISOString() },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/visits/${visit.id}/call-report`,
      headers: auth(rep),
      payload: {
        summary: 'Discussed tolerability',
        objections: [{ objectionType: 'safety', objectionText: 'Wants more tolerability data' }],
      },
    });

    // `objection_type = 'safety'` is a reason an HCP resists a product. It must
    // not have become a clinical record or acquired a patient linkage.
    const { rows } = await getPool().query<Record<string, unknown>>(
      'SELECT * FROM visit_objection LIMIT 1',
    );
    const keys = Object.keys(rows[0]!);
    expect(keys).not.toContain('patient_id');
    expect(keys).not.toContain('encounter_id');
    expect(keys.some((k) => k.startsWith('adverse'))).toBe(false);
  });

  it('exposes no adverse-event or safety-handoff endpoint', async () => {
    // If one appears without the CCR-007 contract being approved, this fails.
    for (const url of [
      '/safety/adverse-events',
      '/safety/handoffs',
      '/pharma/adverse-events',
      '/adverse-events',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth(manager) });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('no pharma table has acquired an adverse-event or patient column', async () => {
    const { rows } = await getPool().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name LIKE 'hcp%' OR table_name LIKE 'call_report%'
               OR table_name LIKE 'visit%' OR table_name LIKE 'scientific%')
          AND (column_name LIKE '%patient%' OR column_name LIKE '%adverse%'
               OR column_name LIKE '%diagnos%')`,
    );
    expect(rows).toEqual([]);
  });

  it('still refuses patient-identifier-shaped text rather than storing it', async () => {
    // Today's behaviour, pinned. CCR-007 proposes replacing reject-and-discard
    // with quarantine — that change must be deliberate, not accidental.
    const hcp = (
      await app.inject({
        method: 'POST',
        url: '/hcps',
        headers: auth(steward),
        payload: { fullName: 'Dr Guarded', professionalCategory: 'physician', provenance: PROV },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/territories/${north.id}/targets`,
      headers: auth(manager),
      payload: { hcpId: hcp.id },
    });
    const visit = (
      await app.inject({
        method: 'POST',
        url: '/visits',
        headers: auth(rep),
        payload: { hcpId: hcp.id, plannedAt: new Date().toISOString() },
      })
    ).json();
    const res = await app.inject({
      method: 'POST',
      url: `/visits/${visit.id}/call-report`,
      headers: auth(rep),
      payload: { summary: 'Reaction reported for MRN-000042 after second dose' },
    });
    expect(res.statusCode).toBe(400);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM call_report');
    expect(rows[0]!.n).toBe(0);
  });
});
