import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

/**
 * CONCURRENCY — the lifecycle guarantees that depend on a race not happening.
 *
 * Every one of these fires two requests AT ONCE (`Promise.all`) against the same
 * record and asserts that exactly one takes effect. The safety comes from the
 * `FOR UPDATE` row lock each write path takes and the partial unique indexes on
 * the open rows; this suite is what proves those are actually load-bearing
 * rather than incidental. A check that reads-then-writes without the lock would
 * let both win here.
 */

let app: FastifyInstance;
let clinicId: string;
let steward: TestUser;
let manager: TestUser;
let reviewer: TestUser;
let rep: TestUser;

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const PROV = { source: 'field_rep', jurisdiction: 'EG' };

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  user: TestUser,
  payload?: Record<string, unknown>,
) {
  return app.inject({ method, url, headers: auth(user), ...(payload ? { payload } : {}) });
}

async function ok(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  user: TestUser,
  payload?: Record<string, unknown>,
) {
  const res = await call(method, url, user, payload);
  if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
  return res.json();
}

/** Exactly one of the two responses succeeded; the other was cleanly refused. */
function exactlyOneWon(a: { statusCode: number }, b: { statusCode: number }) {
  const wins = [a, b].filter((r) => r.statusCode >= 200 && r.statusCode < 300).length;
  const refused = [a, b].filter((r) =>
    [400, 409, 404, 429].includes(r.statusCode),
  ).length;
  return { wins, refused };
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  steward = await makeUser(clinicId, 'cc-steward', RoleKey.PHARMA_DATA_STEWARD);
  manager = await makeUser(clinicId, 'cc-manager', RoleKey.PHARMA_MANAGER);
  reviewer = await makeUser(clinicId, 'cc-reviewer', RoleKey.PHARMA_MANAGER);
  rep = await makeUser(clinicId, 'cc-rep', RoleKey.PHARMA_REP);
});

afterAll(async () => {
  if (app) await app.close();
});

describe('HCP verification — no double transition under a race', () => {
  it('two concurrent verify calls settle to one 200 and one conflict', async () => {
    const hcp = await ok('POST', '/hcps', steward, {
      fullName: 'Dr Race',
      professionalCategory: 'physician',
      provenance: PROV,
    });
    await ok('POST', `/hcps/${hcp.id}/verification`, steward, {
      verificationStatus: 'pending_review',
      evidenceSource: 'register',
    });

    const [a, b] = await Promise.all([
      call('POST', `/hcps/${hcp.id}/verification`, steward, {
        verificationStatus: 'verified',
        evidenceSource: 'register',
      }),
      call('POST', `/hcps/${hcp.id}/verification`, steward, {
        verificationStatus: 'verified',
        evidenceSource: 'register',
      }),
    ]);
    const { wins, refused } = exactlyOneWon(a, b);
    expect(wins).toBe(1);
    expect(refused).toBe(1);

    // One record_version bump, not two.
    const { rows } = await getPool().query<{ record_version: number }>(
      `SELECT record_version FROM hcp WHERE id = $1`,
      [hcp.id],
    );
    expect(rows[0]!.record_version).toBe(3); // create(1) + pending(2) + verified(3)
  });
});

describe('HCP merge — no double merge under a race', () => {
  it('two concurrent merges into different survivors settle to one winner', async () => {
    const loser = await ok('POST', '/hcps', steward, {
      fullName: 'Dr Loser',
      professionalCategory: 'physician',
      provenance: PROV,
    });
    const survivorA = await ok('POST', '/hcps', steward, {
      fullName: 'Dr Survivor A',
      professionalCategory: 'physician',
      provenance: PROV,
    });
    const survivorB = await ok('POST', '/hcps', steward, {
      fullName: 'Dr Survivor B',
      professionalCategory: 'physician',
      provenance: PROV,
    });

    const [a, b] = await Promise.all([
      call('POST', `/hcps/${loser.id}/merge`, steward, {
        targetHcpId: survivorA.id,
        reason: 'duplicate A',
      }),
      call('POST', `/hcps/${loser.id}/merge`, steward, {
        targetHcpId: survivorB.id,
        reason: 'duplicate B',
      }),
    ]);
    const { wins, refused } = exactlyOneWon(a, b);
    expect(wins).toBe(1);
    expect(refused).toBe(1);

    // The loser points at exactly one survivor, and it is one of the two.
    const { rows } = await getPool().query<{ merged_into_hcp_id: string | null }>(
      `SELECT merged_into_hcp_id FROM hcp WHERE id = $1`,
      [loser.id],
    );
    expect([survivorA.id, survivorB.id]).toContain(rows[0]!.merged_into_hcp_id);
  });
});

describe('signal lifecycle — no self-approval or double-publish under a race', () => {
  async function draftSignal(generatedBy: TestUser): Promise<string> {
    // Seed a hand-made in_review draft; this suite is about the decision race,
    // not the pipeline. `generatedBy` is recorded so self-approval can be
    // exercised precisely.
    const { rows: run } = await getPool().query<{ id: string }>(
      `INSERT INTO intelligence_run
         (clinic_id, signal_type, source_kind, scope_type, policy_key, jurisdiction,
          period_start, period_end, min_cohort_size, status, started_at, requested_by)
       VALUES ($1,'hcp_feedback_theme','pharma_field','territory','default','EG',
               current_date - 7, current_date, 5, 'completed', now(), $2) RETURNING id`,
      [clinicId, generatedBy.userId],
    );
    const runId = run[0]!.id;
    const { rows: sig } = await getPool().query<{ id: string }>(
      `INSERT INTO aggregated_signal
         (clinic_id, run_id, signal_type, signal_key, scope_type, jurisdiction,
          aggregation_level, period_start, period_end, value, value_unit, cohort_size,
          min_cohort_size, confidence, source, method, policy_key, generated_by,
          cohort_band, lifecycle_status)
       VALUES ($1,$2,'hcp_feedback_theme','price','territory','EG','territory',
               current_date - 7, current_date, 10, 'count', 10, 5, 0.9,
               'pharma_field','count','default',$3,'10-19','in_review') RETURNING id`,
      [clinicId, runId, generatedBy.userId],
    );
    return sig[0]!.id;
  }

  it('two concurrent approvals settle to one 200 and one conflict', async () => {
    const signalId = await draftSignal(steward); // generator is neither racer
    const [a, b] = await Promise.all([
      call('POST', `/intelligence/signals/${signalId}/decision`, reviewer, { decision: 'approve' }),
      call('POST', `/intelligence/signals/${signalId}/decision`, reviewer, { decision: 'approve' }),
    ]);
    const { wins, refused } = exactlyOneWon(a, b);
    expect(wins).toBe(1);
    expect(refused).toBe(1);

    // Exactly one approval trail entry, so the record cannot show two approvers.
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM aggregated_signal_event
        WHERE signal_id = $1 AND event_type = 'approved'`,
      [signalId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('the generator cannot win an approval race against a reviewer', async () => {
    // The generator is `reviewer` (seed sets generated_by = reviewer). A DIFFERENT
    // principal must be able to approve; the generator must not, whoever gets the
    // lock first.
    const signalId = await draftSignal(reviewer); // generator is `reviewer`
    const [byGenerator, byOther] = await Promise.all([
      call('POST', `/intelligence/signals/${signalId}/decision`, reviewer, { decision: 'approve' }),
      call('POST', `/intelligence/signals/${signalId}/decision`, manager, { decision: 'approve' }),
    ]);
    // The generator's attempt is refused (self-approval) whether it ran first or
    // second; the other principal's either wins or hits the already-approved
    // conflict — never a self-approval slipping through.
    expect(byGenerator.statusCode).toBe(409);
    expect([200, 409]).toContain(byOther.statusCode);
    const { rows } = await getPool().query<{ approved_by: string | null }>(
      `SELECT approved_by FROM aggregated_signal WHERE id = $1`,
      [signalId],
    );
    // If anyone approved, it was not the generator.
    if (rows[0]!.approved_by) expect(rows[0]!.approved_by).toBe(manager.userId);
  });
});

describe('territory assignment — no double revoke under a race', () => {
  it('two concurrent revocations settle to one 200 and one conflict', async () => {
    const territory = await ok('POST', '/territories', manager, {
      code: 'N',
      name: 'North',
      country: 'EG',
    });
    const assignment = await ok('POST', `/territories/${territory.id}/assignments`, manager, {
      userId: rep.userId,
    });
    const [a, b] = await Promise.all([
      call('PATCH', `/territories/${territory.id}/assignments/${assignment.id}`, manager, {}),
      call('PATCH', `/territories/${territory.id}/assignments/${assignment.id}`, manager, {}),
    ]);
    const { wins, refused } = exactlyOneWon(a, b);
    expect(wins).toBe(1);
    expect(refused).toBe(1);
  });
});

describe('affiliation — the open-slot unique index holds under a race', () => {
  it('two concurrent identical affiliations settle to one 201 and one conflict', async () => {
    const hcp = await ok('POST', '/hcps', steward, {
      fullName: 'Dr Affiliate',
      professionalCategory: 'physician',
      provenance: PROV,
    });
    const hco = await ok('POST', '/hcos', steward, {
      name: 'Race Hospital',
      country: 'EG',
      provenance: PROV,
    });
    const body = { hcoId: hco.id, affiliationType: 'primary', source: 'directory' };
    const [a, b] = await Promise.all([
      call('POST', `/hcps/${hcp.id}/affiliations`, steward, body),
      call('POST', `/hcps/${hcp.id}/affiliations`, steward, body),
    ]);
    const wins = [a, b].filter((r) => r.statusCode === 201).length;
    const refused = [a, b].filter((r) => r.statusCode === 409).length;
    expect(wins).toBe(1);
    expect(refused).toBe(1);

    // The partial unique index (end_date IS NULL) admitted exactly one open row.
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM hcp_hco_affiliation
        WHERE hcp_id = $1 AND end_date IS NULL`,
      [hcp.id],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
