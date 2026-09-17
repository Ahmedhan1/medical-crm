import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

/**
 * OPERATOR FREE TEXT ON THE GOVERNANCE PATHS.
 *
 * `guards.ts` has always screened the free text a REPRESENTATIVE types — call
 * report summaries, objections, scientific questions. The audit found the
 * governance paths were not screened at all: `evidenceSource`, verification
 * `note`, merge `reason`, escalation `reason` and a signal's rejection or
 * withdrawal reason are all human-typed, and every one of them lands in a
 * revision trail, the audit log, or — on the HCO and signal paths — a payload
 * on the SHARED event bus that Agent 3's automation engine can subscribe to.
 *
 * A steward pasting an MRN into "what did you check?" is exactly the accident
 * the guard exists to stop, and it is the more dangerous half: those records
 * are append-only, so the mistake cannot be edited out afterwards.
 */

let app: FastifyInstance;
let clinicId: string;
let steward: TestUser;
let manager: TestUser;
let reviewer: TestUser;
let affairs: TestUser;
let rep: TestUser;

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });
const PROV = { source: 'field_rep', jurisdiction: 'EG' };
/** Identifier-shaped tokens the guard refuses, one per detected kind. */
const MRN = 'Checked against MRN-000123';
const NATIONAL_ID = 'Verified with 29001011234567';

let hcpId: string;
let hcoId: string;
let locationId: string;
let departmentId: string;
let medicationId: string;

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

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  steward = await makeUser(clinicId, 'ft-steward', RoleKey.PHARMA_DATA_STEWARD);
  manager = await makeUser(clinicId, 'ft-manager', RoleKey.PHARMA_MANAGER);
  reviewer = await makeUser(clinicId, 'ft-reviewer', RoleKey.PHARMA_MANAGER);
  affairs = await makeUser(clinicId, 'ft-affairs', RoleKey.MEDICAL_AFFAIRS);
  rep = await makeUser(clinicId, 'ft-rep', RoleKey.PHARMA_REP);

  const hcp = await ok('POST', '/hcps', steward, {
    fullName: 'Dr Free Text',
    professionalCategory: 'physician',
    provenance: PROV,
  });
  hcpId = hcp.id;
  const hco = await ok('POST', '/hcos', steward, {
    name: 'Nile Teaching Hospital',
    country: 'EG',
    provenance: PROV,
  });
  hcoId = hco.id;
  const location = await ok('POST', `/hcos/${hcoId}/locations`, steward, {
    label: 'Main campus',
    country: 'EG',
    provenance: PROV,
  });
  locationId = location.id;
  const department = await ok('POST', `/hcos/${hcoId}/departments`, steward, {
    name: 'Cardiology',
    hcoLocationId: locationId,
    provenance: PROV,
  });
  departmentId = department.id;
  const medication = await ok('POST', '/medications', steward, {
    genericName: 'metformin',
    providerKey: 'manual_entry',
    provenance: { source: 'product label', jurisdiction: 'EG' },
  });
  medicationId = medication.id;
});

afterAll(async () => {
  if (app) await app.close();
});

describe('verification evidence is screened on every master', () => {
  const cases: Array<[string, () => string]> = [
    ['HCP', () => `/hcps/${hcpId}/verification`],
    ['HCO', () => `/hcos/${hcoId}/verification`],
    ['HCO site', () => `/hco-locations/${locationId}/verification`],
    ['HCO department', () => `/hco-departments/${departmentId}/verification`],
    ['medication', () => `/medications/${medicationId}/verification`],
  ];

  for (const [label, url] of cases) {
    it(`refuses a patient identifier in the ${label} evidenceSource`, async () => {
      const res = await call('POST', url(), steward, {
        verificationStatus: 'pending_review',
        evidenceSource: MRN,
      });
      expect(res.statusCode).toBe(400);
    });

    it(`refuses a patient identifier in the ${label} verification note`, async () => {
      await ok('POST', url(), steward, {
        verificationStatus: 'pending_review',
        evidenceSource: 'Public register',
      });
      const res = await call('POST', url(), steward, {
        verificationStatus: 'rejected',
        evidenceSource: 'Public register',
        note: NATIONAL_ID,
      });
      expect(res.statusCode).toBe(400);
    });
  }

  it('still accepts a legitimate evidence source', async () => {
    const res = await call('POST', `/hcps/${hcpId}/verification`, steward, {
      verificationStatus: 'pending_review',
      evidenceSource: 'EG Medical Syndicate public register, edition 2026-02',
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('merge and escalation rationales are screened', () => {
  it('refuses a patient identifier in an HCP merge reason', async () => {
    const survivor = await ok('POST', '/hcps', steward, {
      fullName: 'Dr Survivor',
      professionalCategory: 'physician',
      provenance: PROV,
    });
    const res = await call('POST', `/hcps/${hcpId}/merge`, steward, {
      targetHcpId: survivor.id,
      reason: MRN,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a patient identifier in an HCO merge reason', async () => {
    const survivor = await ok('POST', '/hcos', steward, {
      name: 'Survivor Hospital',
      country: 'EG',
      provenance: PROV,
    });
    const res = await call('POST', `/hcos/${hcoId}/merge`, steward, {
      survivorHcoId: survivor.id,
      reason: NATIONAL_ID,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a patient identifier in a scientific-request escalation reason', async () => {
    const territory = await ok('POST', '/territories', manager, {
      code: 'N',
      name: 'North',
      country: 'EG',
    });
    await ok('POST', `/territories/${territory.id}/assignments`, manager, { userId: rep.userId });
    await ok('POST', `/territories/${territory.id}/targets`, manager, { hcpId });
    const request = await ok('POST', '/scientific-requests', rep, {
      hcpId,
      question: 'What is the dose adjustment in renal impairment?',
    });
    await getPool().query(
      `UPDATE scientific_request SET sla_due_at = now() - interval '2 hours' WHERE id = $1`,
      [request.id],
    );
    const res = await call('POST', `/scientific-requests/${request.id}/escalate`, rep, {
      reason: MRN,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a patient identifier in a triage note and in a refusal reason', async () => {
    const territory = await ok('POST', '/territories', manager, {
      code: 'N',
      name: 'North',
      country: 'EG',
    });
    await ok('POST', `/territories/${territory.id}/targets`, manager, { hcpId });
    const request = await ok('POST', '/scientific-requests', affairs, {
      hcpId,
      question: 'What is the dose adjustment in renal impairment?',
    });
    const triage = await call('POST', `/scientific-requests/${request.id}/triage`, affairs, {
      assignedTo: affairs.userId,
      note: MRN,
    });
    expect(triage.statusCode).toBe(400);

    const refusal = await call('POST', `/scientific-requests/${request.id}/answer`, affairs, {
      decision: 'reject',
      reason: NATIONAL_ID,
    });
    expect(refusal.statusCode).toBe(400);
  });
});

describe('a signal decision reason never reaches the trail unscreened', () => {
  it('refuses a patient identifier in a rejection or withdrawal reason', async () => {
    // A hand-made draft: this test is about the reason text, not the pipeline.
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO intelligence_run
         (clinic_id, signal_type, source_kind, scope_type, policy_key, jurisdiction,
          period_start, period_end, min_cohort_size, status, started_at, requested_by)
       VALUES ($1,'hcp_feedback_theme','pharma_field','territory','default','EG',
               current_date - 7, current_date, 5, 'completed', now(), $2)
       RETURNING id`,
      [clinicId, manager.userId],
    );
    const runId = rows[0]!.id;
    const { rows: sig } = await getPool().query<{ id: string }>(
      `INSERT INTO aggregated_signal
         (clinic_id, run_id, signal_type, signal_key, scope_type, jurisdiction,
          aggregation_level, period_start, period_end, value, value_unit,
          cohort_size, min_cohort_size, confidence, source, method, policy_key,
          generated_by, cohort_band, lifecycle_status)
       VALUES ($1,$2,'hcp_feedback_theme','price','territory','EG','territory',
               current_date - 7, current_date, 10, 'count', 10, 5, 0.9,
               'pharma_field','count','default',$3,'10-19','in_review')
       RETURNING id`,
      [clinicId, runId, manager.userId],
    );
    const signalId = sig[0]!.id;

    for (const payload of [
      { decision: 'reject', reason: MRN },
      { decision: 'reject', reason: NATIONAL_ID },
    ]) {
      const res = await call(
        'POST',
        `/intelligence/signals/${signalId}/decision`,
        reviewer,
        payload,
      );
      expect(res.statusCode).toBe(400);
    }

    // Nothing was written, so the append-only trail stayed clean.
    const { rows: events } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM aggregated_signal_event WHERE signal_id = $1`,
      [signalId],
    );
    expect(Number(events[0]!.n)).toBe(0);
  });
});

describe('nothing identifier-shaped reaches an append-only store', () => {
  it('no audit metadata, revision source or event payload carries one', async () => {
    // Exercise the governance paths with clean text, then sweep the stores.
    await ok('POST', `/hcps/${hcpId}/verification`, steward, {
      verificationStatus: 'pending_review',
      evidenceSource: 'EG Medical Syndicate register',
    });
    await ok('POST', `/hcos/${hcoId}/verification`, steward, {
      verificationStatus: 'pending_review',
      evidenceSource: 'EG MOH facility register',
    });

    const patterns = [/\bMRN[-\s]?\d{3,}\b/i, /(?<!\d)\d{11,20}(?!\d)/];
    for (const [table, column] of [
      ['audit_log', 'metadata::text'],
      ['event', 'payload::text'],
      ['hcp_revision', 'source'],
      ['hco_revision', 'source'],
    ] as const) {
      const { rows } = await getPool().query<{ v: string }>(
        `SELECT ${column} AS v FROM ${table} WHERE clinic_id = $1`,
        [clinicId],
      );
      for (const row of rows) {
        for (const pattern of patterns) {
          expect(pattern.test(row.v ?? ''), `${table}.${column} carries an identifier`).toBe(false);
        }
      }
    }
  });
});
