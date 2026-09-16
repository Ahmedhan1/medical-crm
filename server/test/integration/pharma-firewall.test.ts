import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import {
  Permission,
  ROLE_DEFINITIONS,
  RoleKey,
} from '../../src/modules/governance/permissions.js';
import { ClinicalPermission } from '../../src/modules/governance/permissions.clinical.js';
import { PharmaPermission } from '../../src/modules/governance/permissions.pharma.js';
import { ABSOLUTE_MIN_COHORT } from '../../src/modules/intelligence/firewall.js';

let app: FastifyInstance;
let clinicId: string;
let manager: TestUser;
/** A SECOND governance principal: a signal may not be approved by whoever generated it. */
let signalReviewer: TestUser;
let rep: TestUser;
let territory: { id: string };

function auth(user: TestUser) {
  return { authorization: `Bearer ${user.token}` };
}

const PROVENANCE = { source: 'field_rep', jurisdiction: 'EG' };

/**
 * Seed `count` HCPs in the territory, each of whom raised the same objection on
 * a completed visit. Each HCP is one distinct member of the resulting cohort.
 */
async function seedObjectionCohort(count: number, objectionType = 'safety') {
  for (let i = 0; i < count; i += 1) {
    const hcp = (
      await app.inject({
        method: 'POST',
        url: '/hcps',
        headers: auth(manager),
        payload: { fullName: `Dr Cohort ${objectionType} ${i}`, professionalCategory: 'physician', provenance: PROVENANCE },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/territories/${territory.id}/targets`,
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
        objections: [{ objectionType, objectionText: 'Raised a concern about the profile' }],
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

function runTodayRaw(overrides: Record<string, unknown> = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return app.inject({
    method: 'POST',
    url: '/intelligence/runs',
    headers: auth(manager),
    payload: {
      sourceKind: 'pharma_field',
      signalType: 'hcp_feedback_theme',
      periodStart: today,
      periodEnd: today,
      jurisdiction: 'EG',
      scopeType: 'territory',
      aggregationLevel: 'territory',
      ...overrides,
    },
  });
}

/** Run the pipeline, then publish whatever it drafted. */
async function runToday(overrides: Record<string, unknown> = {}) {
  const res = await runTodayRaw(overrides);
  if (res.statusCode < 400) await publishAllSignals();
  return res;
}

beforeEach(async () => {
  await resetDb();
  app = buildServer();
  await app.ready();
  ({ clinicId } = await makeClinic());
  manager = await makeUser(clinicId, 'manager', RoleKey.ADMIN);
  signalReviewer = await makeUser(clinicId, 'signal-reviewer', RoleKey.PHARMA_MANAGER);
  rep = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
  territory = (
    await app.inject({
      method: 'POST',
      url: '/territories',
      headers: auth(manager),
      payload: { code: 'CAI', name: 'Cairo', country: 'EG' },
    })
  ).json();
  await app.inject({
    method: 'POST',
    url: `/territories/${territory.id}/assignments`,
    headers: auth(manager),
    payload: { userId: rep.userId },
  });
});

afterAll(async () => {
  if (app) await app.close();
});

// ---------------------------------------------------------------------------
// The structural firewall: pharma code has no path to clinical data at all.
// ---------------------------------------------------------------------------

const CLINICAL_TABLES = [
  'patient',
  'encounter',
  'qr_token',
  'intake',
  'vital',
  'clinical_note',
  'diagnosis',
  'assessment',
  'treatment_plan',
  'treatment_episode',
  'observation',
];

/** `FROM patient`, `JOIN encounter`, `REFERENCES vital`, … in any form. */
const CLINICAL_REFERENCE = new RegExp(
  String.raw`\b(from|join|into|update|references|table)\s+"?(${CLINICAL_TABLES.join('|')})\b`,
  'i',
);

function filesUnder(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, extension));
    else if (path.endsWith(extension)) out.push(path);
  }
  return out;
}

describe('data firewall — structural (§45)', () => {
  const pharmaSources = [
    'src/modules/pharma',
    'src/modules/hcp',
    'src/modules/drug',
    'src/modules/intelligence',
  ].flatMap((dir) => filesUnder(dir, '.ts'));

  /**
   * Route files to scan, DERIVED from what the pharma feature actually
   * registers rather than hand-listed. A hardcoded list silently stops covering
   * the boundary the moment someone adds a route file — which is exactly the
   * kind of gap this whole suite exists to prevent.
   */
  const pharmaFeaturePath = 'src/http/features/pharma.feature.ts';
  const pharmaRoutes = (() => {
    const feature = readFileSync(pharmaFeaturePath, 'utf8');
    const imported = [...feature.matchAll(/from '\.\.\/routes\/([\w.-]+)\.js'/g)].map(
      (m) => `src/http/routes/${m[1]}.ts`,
    );
    return [...imported, pharmaFeaturePath];
  })();

  /** Comment lines legitimately mention patient data to explain the boundary. */
  function codeOnly(source: string): string {
    return source
      .split('\n')
      .map((line) => line.replace(/^\s*(\/\/|\*|\/\*).*$/, ''))
      .join('\n');
  }

  it('has pharma modules to check (guards against an empty glob passing vacuously)', () => {
    expect(pharmaSources.length).toBeGreaterThan(10);
  });

  it('derives the route list from the feature aggregator, so a new route cannot escape', () => {
    // Every route module the pharma feature registers must be in the scan set,
    // and each must actually exist on disk.
    const feature = readFileSync(pharmaFeaturePath, 'utf8');
    const registered = [...feature.matchAll(/await app\.register\((\w+)\)/g)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThan(4);
    expect(pharmaRoutes.length).toBe(registered.length + 1); // + the feature file itself
    for (const file of pharmaRoutes) {
      expect(existsSync(file), `${file} is scanned but does not exist`).toBe(true);
    }
  });

  it('the detector actually detects a clinical reference (guards against a vacuous check)', () => {
    expect(CLINICAL_REFERENCE.test(codeOnly('const q = `SELECT * FROM patient WHERE id = $1`;'))).toBe(
      true,
    );
    // …including one split across lines, as a formatted query would be.
    expect(CLINICAL_REFERENCE.test(codeOnly('`SELECT p.id\n   FROM patient p\n  WHERE 1=1`'))).toBe(
      true,
    );
    expect(CLINICAL_REFERENCE.test(codeOnly('   // never joins patient rows'))).toBe(false);
  });

  it.each([...pharmaSources, ...pharmaRoutes])(
    'no clinical table is referenced in %s',
    (file) => {
      // Matched over the whole file, not line by line, so a query formatted
      // across several lines cannot slip past the check.
      const code = codeOnly(readFileSync(file, 'utf8'));
      const match = code.match(CLINICAL_REFERENCE);
      expect(match?.[0] ?? null, `${file} references a clinical table`).toBeNull();
    },
  );

  it.each(filesUnder('src/db/migrations', '.sql').filter((f) => /\/03\d\d_/.test(f)))(
    'no pharma table has a foreign key into clinical data in %s',
    (file) => {
      const sql = readFileSync(file, 'utf8');
      for (const table of CLINICAL_TABLES) {
        expect(new RegExp(String.raw`REFERENCES\s+${table}\b`, 'i').test(sql)).toBe(false);
      }
    },
  );

  it('the pharma schema declares no column pointing at a patient or encounter', async () => {
    const { rows } = await getPool().query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name IN (
            'hcp','hco','hcp_identifier','hcp_specialty','hcp_practice_location',
            'hcp_hco_affiliation','hcp_professional_interest','hcp_revision',
            'medication','medication_product','medication_ingredient',
            'territory','territory_assignment','hcp_territory','visit','call_report',
            'call_report_product','visit_objection','call_report_competitor',
            'scientific_request','follow_up_action','approved_content','content_engagement',
            'hcp_segment','hcp_segment_member','campaign','campaign_target',
            'aggregated_signal','intelligence_run','intelligence_policy')
          AND (c.column_name LIKE 'patient%' OR c.column_name LIKE 'encounter%')`,
    );
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The permission firewall: neither side holds the other's permissions.
// ---------------------------------------------------------------------------

describe('data firewall — permission separation', () => {
  it('PHARMA_REP holds no clinical permission', () => {
    const granted = new Set(ROLE_DEFINITIONS[RoleKey.PHARMA_REP].permissions);
    for (const permission of Object.values(ClinicalPermission)) {
      expect(granted.has(permission as never), `PHARMA_REP must not hold ${permission}`).toBe(false);
    }
  });

  it('no clinical role holds any pharma permission', () => {
    const pharmaPermissions = new Set<string>(Object.values(PharmaPermission));
    for (const role of [RoleKey.RECEPTION, RoleKey.NURSE, RoleKey.DOCTOR]) {
      for (const permission of ROLE_DEFINITIONS[role].permissions) {
        expect(pharmaPermissions.has(permission), `${role} must not hold ${permission}`).toBe(false);
      }
    }
  });

  it('PHARMA_REP holds none of the pharma governance permissions', () => {
    const granted = new Set<string>(ROLE_DEFINITIONS[RoleKey.PHARMA_REP].permissions);
    for (const permission of [
      Permission.HCP_VERIFY,
      Permission.HCP_MERGE,
      Permission.MEDICATION_WRITE,
      Permission.TERRITORY_MANAGE,
      Permission.CONTENT_APPROVE,
      Permission.INTELLIGENCE_PUBLISH,
      Permission.SCIENTIFIC_REQUEST_FULFILL,
    ]) {
      expect(granted.has(permission), `PHARMA_REP must not hold ${permission}`).toBe(false);
    }
  });

  it('a doctor cannot reach any pharma endpoint', async () => {
    const doctor = await makeUser(clinicId, 'doctor', RoleKey.DOCTOR);
    for (const url of [
      '/hcps',
      '/medications',
      '/territories',
      '/visits',
      '/scientific-requests',
      '/pharma/content',
      '/pharma/segments',
      '/pharma/campaigns',
      '/intelligence/signals',
      '/intelligence/sources',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth(doctor) });
      expect(res.statusCode, `${url} should be forbidden for a doctor`).toBe(403);
    }
  });

  it('a pharma representative still cannot reach patient data', async () => {
    const reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
    const patient = (
      await app.inject({
        method: 'POST',
        url: '/patients',
        headers: auth(reception),
        payload: { fullName: 'Protected Person', sex: 'female' },
      })
    ).json();

    for (const request of [
      { method: 'GET' as const, url: `/patients/${patient.id}` },
      { method: 'GET' as const, url: '/patients/search?q=Protected' },
      { method: 'GET' as const, url: '/queue' },
    ]) {
      const res = await app.inject({ ...request, headers: auth(rep) });
      expect(res.statusCode, `${request.url}`).toBe(403);
    }
  });

  it('no pharma response body contains a patient name or MRN', async () => {
    const reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
    const patient = (
      await app.inject({
        method: 'POST',
        url: '/patients',
        headers: auth(reception),
        payload: { fullName: 'Zzyzx Unmistakable', sex: 'male' },
      })
    ).json();
    await seedObjectionCohort(ABSOLUTE_MIN_COHORT);
    await runToday();

    for (const url of [
      '/hcps',
      '/rep/territory',
      '/rep/today',
      '/visits',
      '/scientific-requests',
      '/intelligence/signals',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth(rep) });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('Zzyzx');
      expect(res.body).not.toContain(patient.mrn);
      expect(res.body).not.toContain(patient.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Free text is the only hand-carried route for patient data; it is screened.
// ---------------------------------------------------------------------------

describe('data firewall — patient identifiers in pharma free text', () => {
  async function plannedVisit() {
    const hcp = (
      await app.inject({
        method: 'POST',
        url: '/hcps',
        headers: auth(manager),
        payload: { fullName: 'Dr Free Text', professionalCategory: 'physician', provenance: PROVENANCE },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/territories/${territory.id}/targets`,
      headers: auth(manager),
      payload: { hcpId: hcp.id },
    });
    return {
      hcp,
      visit: (
        await app.inject({
          method: 'POST',
          url: '/visits',
          headers: auth(rep),
          payload: { hcpId: hcp.id, plannedAt: new Date().toISOString() },
        })
      ).json(),
    };
  }

  it('rejects a call-report summary containing an MRN', async () => {
    const { visit } = await plannedVisit();
    const res = await app.inject({
      method: 'POST',
      url: `/visits/${visit.id}/call-report`,
      headers: auth(rep),
      payload: { summary: 'Discussed the case of MRN-000042 at length' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.detected).toBe('mrn');
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM call_report');
    expect(rows[0]!.n).toBe(0);
  });

  it('rejects an objection containing a national-identifier-shaped number', async () => {
    const { visit } = await plannedVisit();
    const res = await app.inject({
      method: 'POST',
      url: `/visits/${visit.id}/call-report`,
      headers: auth(rep),
      payload: {
        summary: 'Routine call',
        objections: [
          { objectionType: 'safety', objectionText: 'Patient 29001011234567 had a reaction' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.detected).toBe('national_id');
  });

  it('rejects a scientific question containing a record UUID', async () => {
    const { hcp } = await plannedVisit();
    const res = await app.inject({
      method: 'POST',
      url: '/scientific-requests',
      headers: auth(rep),
      payload: {
        hcpId: hcp.id,
        question: 'What about the case at 3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d?',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.detected).toBe('record_uuid');
  });

  it('accepts ordinary clinical-sounding prose with no identifiers', async () => {
    const { visit } = await plannedVisit();
    const res = await app.inject({
      method: 'POST',
      url: `/visits/${visit.id}/call-report`,
      headers: auth(rep),
      payload: {
        summary: 'Discussed renal dosing in elderly patients and the 12-week outcome data.',
        objections: [{ objectionType: 'efficacy', objectionText: 'Wants head-to-head evidence' }],
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// The governed clinical read path is blocked until CCR-001 is approved.
// ---------------------------------------------------------------------------

describe('intelligence firewall — the clinical source is not wired', () => {
  it('advertises the clinical source as unavailable', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/intelligence/sources',
      headers: auth(rep),
    });
    const sources = res.json().sources;
    expect(sources.find((s: { key: string }) => s.key === 'pharma_field').available).toBe(true);
    const clinical = sources.find((s: { key: string }) => s.key === 'clinical_governed');
    expect(clinical.available).toBe(false);
    expect(clinical.description).toMatch(/CCR-001/);
  });

  it('refuses a run against clinical data and records the denial', async () => {
    const res = await runToday({ sourceKind: 'clinical_governed' });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('governed_read_contract_unavailable');
    expect(res.json().error.details.contract).toBe('CCR-001');

    const { rows } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'intelligence.run.denied'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);

    // Nothing was published, and no run row claims success.
    const signals = await getPool().query('SELECT count(*)::int AS n FROM aggregated_signal');
    expect(signals.rows[0]!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the pipeline over pharma's own field data.
// ---------------------------------------------------------------------------

describe('intelligence firewall — end to end over field data', () => {
  it('publishes nothing when the cohort is below the threshold', async () => {
    await seedObjectionCohort(ABSOLUTE_MIN_COHORT - 1);
    const res = await runToday();
    expect(res.statusCode).toBe(201);
    const outcome = res.json();
    expect(outcome.signalsPublished).toBe(0);
    expect(outcome.signals).toEqual([]);
    expect(outcome.cohortsSuppressed).toBe(1);

    const read = await app.inject({
      method: 'GET',
      url: '/intelligence/signals',
      headers: auth(rep),
    });
    expect(read.json().signals).toEqual([]);
  });

  it('publishes a signal once the cohort reaches the threshold', async () => {
    await seedObjectionCohort(ABSOLUTE_MIN_COHORT);
    const res = await runToday();
    expect(res.statusCode).toBe(201);
    const outcome = res.json();
    expect(outcome.signalsPublished).toBe(1);

    const signal = outcome.signals[0];
    expect(signal).toMatchObject({
      signalType: 'hcp_feedback_theme',
      signalKey: 'safety',
      scopeType: 'territory',
      scopeId: territory.id,
      jurisdiction: 'EG',
      aggregationLevel: 'territory',
      valueUnit: 'count',
      // Phase 28: the published surface is a band; the exact count stays in the
      // database for the operator audit only.
      cohortBand: `${ABSOLUTE_MIN_COHORT}-9`,
      minCohortSize: ABSOLUTE_MIN_COHORT,
      policyKey: 'default',
      policyStatus: 'passed',
      deidentified: true,
    });
    // The full governance envelope travels with the number.
    expect(signal.confidence).toBeGreaterThan(0);
    expect(signal.source).toBe('pharma_field');
    expect(signal.method).toMatch(/de-identified and threshold-gated/);
    expect(signal.provenance.pipeline).toContain('min_cohort_threshold');
    expect(signal.generatedAt).toBeTruthy();
  });

  it('suppresses the small cohort while publishing the large one', async () => {
    // Three cohorts: one large, one medium, one below threshold. The small one
    // is suppressed by the threshold and — because a lone suppressed cell is
    // recoverable by subtraction — the SMALLEST survivor is withheld with it
    // (Phase 28 complementary suppression). The large cohort still publishes.
    await seedObjectionCohort(ABSOLUTE_MIN_COHORT + 7, 'cost');
    await seedObjectionCohort(ABSOLUTE_MIN_COHORT + 1, 'efficacy');
    await seedObjectionCohort(2, 'guideline');
    const outcome = (await runToday()).json();
    expect(outcome.signals.map((s: { signalKey: string }) => s.signalKey)).toEqual(['cost']);
    expect(outcome.cohortsSuppressed).toBe(2);
  });

  it('publishes NOTHING when suppressing one cohort would expose it by subtraction', async () => {
    // Only two cohorts, one below threshold. Publishing the survivor alongside a
    // single hidden cell would disclose the hidden one, so neither is published.
    // This is a deliberate utility cost of disclosure control, not a bug.
    await seedObjectionCohort(ABSOLUTE_MIN_COHORT + 2, 'cost');
    await seedObjectionCohort(2, 'guideline');
    const outcome = (await runToday()).json();
    expect(outcome.signals).toEqual([]);
    expect(outcome.cohortsSuppressed).toBe(2);
  });

  it('carries no HCP identifier into a published signal', async () => {
    await seedObjectionCohort(ABSOLUTE_MIN_COHORT);
    const hcps = (await app.inject({ method: 'GET', url: '/hcps', headers: auth(manager) })).json()
      .results as Array<{ id: string; fullName: string }>;
    await runToday();

    const res = await app.inject({
      method: 'GET',
      url: '/intelligence/signals',
      headers: auth(rep),
    });
    for (const hcp of hcps) {
      expect(res.body).not.toContain(hcp.id);
      expect(res.body).not.toContain(hcp.fullName);
    }
  });

  it('a representative can read signals but cannot produce them', async () => {
    await seedObjectionCohort(ABSOLUTE_MIN_COHORT);
    await runToday();

    const read = await app.inject({
      method: 'GET',
      url: '/intelligence/signals',
      headers: auth(rep),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().signals).toHaveLength(1);

    const today = new Date().toISOString().slice(0, 10);
    const publish = await app.inject({
      method: 'POST',
      url: '/intelligence/runs',
      headers: auth(rep),
      payload: {
        signalType: 'hcp_feedback_theme',
        periodStart: today,
        periodEnd: today,
        jurisdiction: 'EG',
      },
    });
    expect(publish.statusCode).toBe(403);
  });

  it('re-running a period replaces the signal rather than duplicating it', async () => {
    await seedObjectionCohort(ABSOLUTE_MIN_COHORT);
    await runToday();
    await runToday();
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM aggregated_signal');
    expect(rows[0]!.n).toBe(1);
  });

  it('records the run, including how many cohorts were suppressed', async () => {
    await seedObjectionCohort(ABSOLUTE_MIN_COHORT, 'cost');
    await seedObjectionCohort(1, 'safety');
    await runToday();
    const res = await app.inject({
      method: 'GET',
      url: '/intelligence/runs',
      headers: auth(manager),
    });
    expect(res.json().runs[0]).toMatchObject({
      sourceKind: 'pharma_field',
      signalType: 'hcp_feedback_theme',
      status: 'completed',
      // The lone below-threshold cohort is suppressed, and the single survivor
      // is withheld with it (complementary suppression), so nothing publishes.
      signalsPublished: 0,
      cohortsSuppressed: 2,
      minCohortSize: ABSOLUTE_MIN_COHORT,
    });
  });
});

// ---------------------------------------------------------------------------
// The threshold cannot be weakened, from the API or from the database.
// ---------------------------------------------------------------------------

describe('intelligence firewall — the threshold is not negotiable', () => {
  it('refuses a policy with a cohort minimum below the floor', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/intelligence/policies',
      headers: auth(manager),
      payload: {
        key: 'loose',
        description: 'Attempt to weaken the threshold',
        jurisdiction: 'EG',
        minCohortSize: 2,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('honours a policy stricter than the floor', async () => {
    await app.inject({
      method: 'PUT',
      url: '/intelligence/policies',
      headers: auth(manager),
      payload: {
        key: 'strict',
        description: 'Stricter cohort minimum for sensitive themes',
        jurisdiction: 'EG',
        minCohortSize: 20,
      },
    });
    await seedObjectionCohort(ABSOLUTE_MIN_COHORT + 3);
    const outcome = (await runToday({ policyKey: 'strict' })).json();
    expect(outcome.minCohortSize).toBe(20);
    expect(outcome.signalsPublished).toBe(0);
  });

  it('the database refuses a signal below the threshold that governed it', async () => {
    await expect(
      getPool().query(
        `INSERT INTO aggregated_signal
           (clinic_id, signal_type, signal_key, scope_type, scope_id, jurisdiction,
            aggregation_level, period_start, period_end, value, value_unit, cohort_size,
            min_cohort_size, confidence, source, method, policy_key)
         VALUES ($1,'smuggled','x','territory','t','EG','territory','2026-01-01','2026-01-31',
                 1,'count',2,5,0.5,'manual','hand-inserted','default')`,
        [clinicId],
      ),
    ).rejects.toThrow(/signal_meets_threshold/);
  });

  it('the database refuses a threshold below the absolute floor', async () => {
    await expect(
      getPool().query(
        `INSERT INTO intelligence_policy (clinic_id, key, description, jurisdiction, min_cohort_size)
         VALUES ($1,'floor-breach','x','EG',1)`,
        [clinicId],
      ),
    ).rejects.toThrow(/min_cohort_size/);
  });

  it('the database refuses a signal that is not de-identified', async () => {
    await expect(
      getPool().query(
        `INSERT INTO aggregated_signal
           (clinic_id, signal_type, signal_key, scope_type, scope_id, jurisdiction,
            aggregation_level, period_start, period_end, value, value_unit, cohort_size,
            min_cohort_size, confidence, source, method, policy_key, deidentified)
         VALUES ($1,'smuggled','x','territory','t','EG','territory','2026-01-01','2026-01-31',
                 1,'count',10,5,0.5,'manual','hand-inserted','default', false)`,
        [clinicId],
      ),
    ).rejects.toThrow(/deidentified/);
  });
});

describe('intelligence — territory scope applies to signals too', () => {
  it('a representative does not see another territory\'s signals', async () => {
    await seedObjectionCohort(ABSOLUTE_MIN_COHORT);
    await runToday();

    const otherRep = await makeUser(clinicId, 'rep-other', RoleKey.PHARMA_REP);
    const otherTerritory = (
      await app.inject({
        method: 'POST',
        url: '/territories',
        headers: auth(manager),
        payload: { code: 'ALX', name: 'Alexandria', country: 'EG' },
      })
    ).json();
    await app.inject({
      method: 'POST',
      url: `/territories/${otherTerritory.id}/assignments`,
      headers: auth(manager),
      payload: { userId: otherRep.userId },
    });

    const mine = await app.inject({
      method: 'GET',
      url: '/intelligence/signals',
      headers: auth(rep),
    });
    expect(mine.json().signals).toHaveLength(1);

    const theirs = await app.inject({
      method: 'GET',
      url: '/intelligence/signals',
      headers: auth(otherRep),
    });
    expect(theirs.json().signals).toEqual([]);
  });

  it('signals are isolated between clinics', async () => {
    await seedObjectionCohort(ABSOLUTE_MIN_COHORT);
    await runToday();

    const other = await makeClinic('Other Clinic');
    const otherManager = await makeUser(other.clinicId, 'mgr2', RoleKey.ADMIN);
    const res = await app.inject({
      method: 'GET',
      url: '/intelligence/signals',
      headers: auth(otherManager),
    });
    expect(res.json().signals).toEqual([]);
  });
});
