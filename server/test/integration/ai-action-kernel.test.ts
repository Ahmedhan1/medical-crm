import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { authorizeAiAction } from '../../src/modules/ai/kernel/guard.js';
import { executeAiAction } from '../../src/modules/ai/kernel/execute.js';
import { issueConfirmationToken } from '../../src/modules/ai/kernel/confirmation.js';
import { registerTool, resetToolRegistry, PROHIBITED_CLINICAL_TOOL_IDS } from '../../src/modules/ai/kernel/tools.js';
import { RiskClass } from '../../src/modules/ai/kernel/risk.js';
import { DataClass } from '../../src/modules/ai/classification.js';

let app: FastifyInstance;
let clinicId: string;
let admin: { token: string };
let nameSeq = 0;

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface Id { id: string }
async function mkId(over: Partial<{ agentType: string; name: string; scopes: string[]; riskCeiling: string; dataCeiling: string }> = {}): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/ai/identities', headers: bearer(admin.token),
    payload: {
      agentType: over.agentType ?? 'test_agent',
      name: over.name ?? `agent-${nameSeq++}`,
      scopes: over.scopes ?? [],
      riskCeiling: over.riskCeiling ?? 'read_only',
      dataCeiling: over.dataCeiling ?? 'internal',
    },
  });
  return (res.json() as Id).id;
}

beforeEach(async () => {
  await resetDb();
  resetToolRegistry();
  ({ clinicId } = await makeClinic());
  admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
  app = buildServer();
  await app.ready();
  nameSeq = 0;
});
afterEach(() => resetToolRegistry());
afterAll(async () => { if (app) await app.close(); });

describe('kernel: identity gates', () => {
  it('allows a valid identity with the right scope/ceilings (READ_ONLY)', async () => {
    const id = await mkId({ scopes: ['ai:demo-read'] });
    const d = await authorizeAiAction({ clinicId, identityId: id, toolId: 'demo.echo', dataClass: DataClass.INTERNAL });
    expect(d.decision).toBe('allow');
    const run = await executeAiAction({ clinicId, identityId: id, toolId: 'demo.echo' });
    expect(run.executed).toBe(true);
    expect(run.result).toEqual({ pong: true });
  });

  it('denies a disabled identity', async () => {
    const id = await mkId({ scopes: ['ai:demo-read'] });
    await app.inject({ method: 'POST', url: `/ai/identities/${id}/disable`, headers: bearer(admin.token) });
    const d = await authorizeAiAction({ clinicId, identityId: id, toolId: 'demo.echo' });
    expect(d.decision).toBe('deny');
    expect(d.reasonCode).toBe('identity_disabled');
  });

  it('denies an unknown identity', async () => {
    const d = await authorizeAiAction({ clinicId, identityId: '00000000-0000-0000-0000-000000000000', toolId: 'demo.echo' });
    expect(d).toMatchObject({ decision: 'deny', reasonCode: 'unknown_identity' });
  });
});

describe('kernel: tool registry gates', () => {
  it('denies an unknown tool (fail closed)', async () => {
    const id = await mkId({ scopes: ['ai:demo-read'] });
    const d = await authorizeAiAction({ clinicId, identityId: id, toolId: 'invented.tool' });
    expect(d).toMatchObject({ decision: 'deny', reasonCode: 'unknown_tool' });
  });

  it('denies a disabled tool', async () => {
    registerTool({ id: 'demo.disabled', name: 'disabled', description: '', access: 'read', requiredScope: 'ai:demo-read', dataCeiling: DataClass.INTERNAL, risk: RiskClass.READ_ONLY, requiresConfirmation: false, enabled: false });
    const id = await mkId({ scopes: ['ai:demo-read'] });
    const d = await authorizeAiAction({ clinicId, identityId: id, toolId: 'demo.disabled' });
    expect(d).toMatchObject({ decision: 'deny', reasonCode: 'tool_disabled' });
  });

  it('denies when the identity lacks the tool scope', async () => {
    const id = await mkId({ scopes: ['ai:something-else'] });
    const d = await authorizeAiAction({ clinicId, identityId: id, toolId: 'demo.echo' });
    expect(d).toMatchObject({ decision: 'deny', reasonCode: 'missing_permission' });
  });
});

describe('kernel: risk gates', () => {
  it('allows LOW_RISK write within ceiling and executes', async () => {
    const id = await mkId({ scopes: ['ai:demo-write'], riskCeiling: 'low_risk', dataCeiling: 'operational' });
    const run = await executeAiAction({ clinicId, identityId: id, toolId: 'demo.write_note' });
    expect(run.executed).toBe(true);
    expect(run.result).toEqual({ written: true });
  });

  it('denies a write above the identity risk ceiling', async () => {
    const id = await mkId({ scopes: ['ai:demo-write'], riskCeiling: 'read_only', dataCeiling: 'operational' });
    const d = await authorizeAiAction({ clinicId, identityId: id, toolId: 'demo.write_note' });
    expect(d).toMatchObject({ decision: 'deny', reasonCode: 'risk_exceeds_ceiling' });
  });

  it('requires confirmation for a MEDIUM_RISK tool and executes only once confirmed', async () => {
    const id = await mkId({ scopes: ['ai:demo-write'], riskCeiling: 'medium_risk', dataCeiling: 'operational' });
    // Without confirmation → require_confirmation, no execution.
    const noConfirm = await executeAiAction({ clinicId, identityId: id, toolId: 'demo.reschedule', dataClass: DataClass.OPERATIONAL });
    expect(noConfirm.executed).toBe(false);
    expect(noConfirm.authorization.decision).toBe('require_confirmation');

    // With a valid human-issued confirmation token bound to the action → executes.
    const token = issueConfirmationToken({ clinicId, identityId: id, toolId: 'demo.reschedule', dataClass: DataClass.OPERATIONAL });
    const confirmed = await executeAiAction({ clinicId, identityId: id, toolId: 'demo.reschedule', dataClass: DataClass.OPERATIONAL, confirmationToken: token });
    expect(confirmed.executed).toBe(true);
    expect(confirmed.result).toEqual({ rescheduled: true });
  });
});

describe('kernel: classification gates (reuses E3 model)', () => {
  it('denies a data class above the tool ceiling', async () => {
    const id = await mkId({ scopes: ['ai:demo-read'], dataCeiling: 'phi' });
    const d = await authorizeAiAction({ clinicId, identityId: id, toolId: 'demo.echo', dataClass: DataClass.PHI });
    expect(d).toMatchObject({ decision: 'deny', reasonCode: 'classification_exceeds_tool_ceiling' });
  });

  it('denies a PHI tool when the identity data ceiling is below PHI', async () => {
    const id = await mkId({ scopes: ['read:patient'], dataCeiling: 'operational' });
    const d = await authorizeAiAction({ clinicId, identityId: id, toolId: 'patient.search' });
    expect(d).toMatchObject({ decision: 'deny', reasonCode: 'classification_exceeds_identity_ceiling' });
  });

  it('a PHI read tool authorizes when identity ceiling permits, but has no handler yet', async () => {
    const id = await mkId({ scopes: ['read:patient'], dataCeiling: 'phi' });
    const run = await executeAiAction({ clinicId, identityId: id, toolId: 'patient.search' });
    expect(run.authorization.decision).toBe('allow');
    expect(run.executed).toBe(false);
    expect(run.reason).toBe('no_handler'); // real handler deferred to owner via CCR
  });
});

describe('kernel: clinical safety boundary', () => {
  it('denies EVERY prohibited clinical operation, even for a maximally-privileged identity', async () => {
    const id = await mkId({ scopes: ['prohibited', 'read:patient'], riskCeiling: 'high_risk', dataCeiling: 'highly_restricted' });
    for (const toolId of PROHIBITED_CLINICAL_TOOL_IDS) {
      const d = await authorizeAiAction({ clinicId, identityId: id, toolId, dataClass: DataClass.HIGHLY_RESTRICTED });
      expect(d.decision, toolId).toBe('deny');
      expect(d.reasonCode, toolId).toBe('prohibited');
      const run = await executeAiAction({ clinicId, identityId: id, toolId });
      expect(run.executed, toolId).toBe(false);
    }
  });
});

describe('kernel: tenant isolation', () => {
  it('a clinic cannot use another clinic AI identity', async () => {
    const idA = await mkId({ scopes: ['ai:demo-read'] });
    const clinicB = await makeClinic('Clinic B');
    // Same identity id, but evaluated under clinic B's scope → not found.
    const d = await authorizeAiAction({ clinicId: clinicB.clinicId, identityId: idA, toolId: 'demo.echo' });
    expect(d).toMatchObject({ decision: 'deny', reasonCode: 'unknown_identity' });
  });
});

describe('kernel: observability contains no PHI or arguments', () => {
  it('never records tool arguments (patient data) in ai_action_log', async () => {
    const id = await mkId({ scopes: ['ai:demo-write'], riskCeiling: 'low_risk', dataCeiling: 'operational' });
    await executeAiAction({
      clinicId, identityId: id, toolId: 'demo.write_note',
      args: { patientName: 'Ahmed Hassan', complaint: 'severe headache', phone: '+201234567890', diagnosis: 'migraine' },
    });
    const log = await getPool().query<{ blob: string }>(
      `SELECT coalesce(string_agg(row_to_json(ai_action_log)::text, ' '), '') AS blob FROM ai_action_log WHERE clinic_id = $1`, [clinicId]);
    for (const phi of ['Ahmed Hassan', 'severe headache', '+201234567890', 'migraine']) {
      expect(log.rows[0]!.blob).not.toContain(phi);
    }
    // But the decision itself IS recorded.
    expect(log.rows[0]!.blob).toContain('demo.write_note');
    expect(log.rows[0]!.blob).toContain('allow');
  });

  it('ai_action_log is append-only', async () => {
    await expect(getPool().query('DELETE FROM ai_action_log')).rejects.toThrow(/append-only/);
    await expect(getPool().query("UPDATE ai_action_log SET decision = 'allow'")).rejects.toThrow(/append-only/);
  });
});

describe('kernel: authorization of the management surface', () => {
  it('only ADMIN (ai:identity-manage) can manage identities', async () => {
    const reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
    const pharma = await makeUser(clinicId, 'rep', RoleKey.PHARMA_REP);
    for (const t of [reception.token, pharma.token]) {
      const res = await app.inject({ method: 'POST', url: '/ai/identities', headers: bearer(t), payload: { agentType: 'x', name: 'y' } });
      expect(res.statusCode).toBe(403);
    }
    const ok = await app.inject({ method: 'POST', url: '/ai/identities', headers: bearer(admin.token), payload: { agentType: 'x', name: 'y' } });
    expect(ok.statusCode).toBe(201);
  });

  it('HTTP confirm→execute round-trip for a medium-risk action', async () => {
    const id = await mkId({ scopes: ['ai:demo-write'], riskCeiling: 'medium_risk', dataCeiling: 'operational' });
    const confirm = await app.inject({
      method: 'POST', url: '/ai/actions/confirm', headers: bearer(admin.token),
      payload: { identityId: id, toolId: 'demo.reschedule', dataClass: 'operational' },
    });
    expect(confirm.statusCode).toBe(200);
    const token = confirm.json().confirmationToken;
    const exec = await app.inject({
      method: 'POST', url: '/ai/actions/execute', headers: bearer(admin.token),
      payload: { identityId: id, toolId: 'demo.reschedule', dataClass: 'operational', confirmationToken: token },
    });
    expect(exec.statusCode).toBe(200);
    expect(exec.json().executed).toBe(true);
  });
});

describe('kernel: RED-TEAM — every bypass attempt fails closed', () => {
  it('resists identity/tool/scope/risk/classification/tenant/confirmation attacks', async () => {
    const weak = await mkId({ scopes: ['ai:demo-read'], riskCeiling: 'read_only', dataCeiling: 'internal' });
    const strong = await mkId({ scopes: ['prohibited', 'ai:demo-write', 'read:patient'], riskCeiling: 'high_risk', dataCeiling: 'highly_restricted' });
    const clinicB = await makeClinic('RT Clinic B');

    const attempts: Array<[string, Awaited<ReturnType<typeof authorizeAiAction>>]> = [
      ['1 unknown tool name', await authorizeAiAction({ clinicId, identityId: weak, toolId: 'db.dropTables' })],
      ['2 fabricated tool metadata (still unknown)', await authorizeAiAction({ clinicId, identityId: weak, toolId: 'demo.echo; DROP TABLE' })],
      ['3 fake AI identity', await authorizeAiAction({ clinicId, identityId: '11111111-1111-1111-1111-111111111111', toolId: 'demo.echo' })],
      ['4 cross-tenant identity', await authorizeAiAction({ clinicId: clinicB.clinicId, identityId: weak, toolId: 'demo.echo' })],
      ['5 missing permission', await authorizeAiAction({ clinicId, identityId: weak, toolId: 'demo.write_note' })],
      ['7 client cannot lower a tool risk (write still needs the ceiling)', await authorizeAiAction({ clinicId, identityId: weak, toolId: 'demo.reschedule', dataClass: DataClass.OPERATIONAL })],
      ['8 classification downgrade on a PHI tool', await authorizeAiAction({ clinicId, identityId: await mkId({ scopes: ['read:patient'], dataCeiling: 'operational' }), toolId: 'patient.search', dataClass: DataClass.PUBLIC })],
      ['15 prohibited clinical action with max privileges', await authorizeAiAction({ clinicId, identityId: strong, toolId: 'clinical.prescription.create', dataClass: DataClass.HIGHLY_RESTRICTED })],
    ];
    for (const [label, d] of attempts) {
      expect(['deny', 'require_confirmation'], label).toContain(d.decision);
      expect(d.decision, label).not.toBe('allow');
    }

    // 6 "ADMIN-like" identity: a human-role-shaped scope grants nothing — no tool maps to it.
    const fakeAdmin = await mkId({ scopes: ['admin:*', 'patient:register', '*'], riskCeiling: 'high_risk', dataCeiling: 'highly_restricted' });
    expect((await authorizeAiAction({ clinicId, identityId: fakeAdmin, toolId: 'demo.echo' })).reasonCode).toBe('missing_permission');
    expect((await authorizeAiAction({ clinicId, identityId: fakeAdmin, toolId: 'clinical.diagnosis.modify' })).reasonCode).toBe('prohibited');

    // 10 missing confirmation → never executes.
    const mid = await mkId({ scopes: ['ai:demo-write'], riskCeiling: 'medium_risk', dataCeiling: 'operational' });
    expect((await executeAiAction({ clinicId, identityId: mid, toolId: 'demo.reschedule', dataClass: DataClass.OPERATIONAL })).executed).toBe(false);

    // 13 forged confirmation token → still not confirmed.
    expect((await executeAiAction({ clinicId, identityId: mid, toolId: 'demo.reschedule', dataClass: DataClass.OPERATIONAL, confirmationToken: 'forged.token' })).executed).toBe(false);
  });
});
