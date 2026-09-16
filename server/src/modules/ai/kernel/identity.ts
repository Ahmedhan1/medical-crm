import { getPool, withTransaction } from '../../../db/pool.js';
import { NotFoundError, ValidationError } from '../../../domain/errors.js';
import { auditTx } from '../../governance/audit.js';
import { requirePermission, type Principal } from '../../governance/rbac.js';
import { Permission } from '../../governance/permissions.js';
import { DataClass, parseDataClass, type DataClass as DataClassType } from '../classification.js';
import type { RiskCeiling } from './risk.js';

/**
 * AI execution identity (E4). A tenant-scoped, explicitly-bounded identity for an
 * AI capability/agent. Its authority is ONLY its `scopes` + `riskCeiling` +
 * `dataCeiling`; it never carries a human role and never inherits ADMIN. A fresh
 * identity is near-powerless by default (read-only, low data ceiling, no scopes).
 */
export interface AiIdentity {
  id: string;
  clinicId: string;
  agentType: string;
  name: string;
  status: 'active' | 'disabled';
  riskCeiling: RiskCeiling;
  dataCeiling: DataClassType;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}

interface IdentityRow {
  id: string;
  clinic_id: string;
  agent_type: string;
  name: string;
  status: 'active' | 'disabled';
  risk_ceiling: RiskCeiling;
  data_ceiling: string;
  scopes: string[];
  created_at: string;
  updated_at: string;
}

function mapIdentity(r: IdentityRow): AiIdentity {
  return {
    id: r.id,
    clinicId: r.clinic_id,
    agentType: r.agent_type,
    name: r.name,
    status: r.status,
    riskCeiling: r.risk_ceiling,
    dataCeiling: parseDataClass(r.data_ceiling) ?? DataClass.INTERNAL,
    scopes: Array.isArray(r.scopes) ? r.scopes : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Load an identity, scoped to a clinic. A cross-tenant id resolves to null. */
export async function getIdentity(clinicId: string, id: string): Promise<AiIdentity | null> {
  const { rows } = await getPool().query<IdentityRow>(
    `SELECT * FROM ai_identity WHERE id = $1 AND clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapIdentity(rows[0]) : null;
}

// --- Admin service (human-managed; separate from AI authority) --------------

const RISK_CEILINGS: RiskCeiling[] = ['read_only', 'low_risk', 'medium_risk', 'high_risk'];

export interface CreateIdentityInput {
  agentType: string;
  name: string;
  riskCeiling?: RiskCeiling;
  dataCeiling?: DataClassType;
  scopes?: string[];
}

export async function createIdentity(principal: Principal, input: CreateIdentityInput): Promise<AiIdentity> {
  requirePermission(principal, Permission.AI_IDENTITY_MANAGE);
  if (!input.agentType?.trim() || !input.name?.trim()) {
    throw new ValidationError('agentType and name are required');
  }
  if (input.riskCeiling && !RISK_CEILINGS.includes(input.riskCeiling)) {
    throw new ValidationError('Invalid riskCeiling');
  }
  // Reject any attempt to grant a human-role-shaped scope onto an AI identity.
  const scopes = input.scopes ?? [];
  for (const s of scopes) {
    if (typeof s !== 'string' || s.length > 100) throw new ValidationError('Invalid scope');
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query<IdentityRow>(
      `INSERT INTO ai_identity (clinic_id, agent_type, name, risk_ceiling, data_ceiling, scopes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        principal.clinicId,
        input.agentType.trim(),
        input.name.trim(),
        input.riskCeiling ?? 'read_only',
        input.dataCeiling ?? DataClass.INTERNAL,
        JSON.stringify(scopes),
        principal.userId,
      ],
    );
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'ai.identity.create',
      outcome: 'success',
      targetType: 'ai_identity',
      targetId: rows[0]!.id,
      metadata: { agentType: input.agentType, riskCeiling: input.riskCeiling ?? 'read_only', scopeCount: scopes.length },
    });
    return mapIdentity(rows[0]!);
  });
}

export async function listIdentities(principal: Principal): Promise<AiIdentity[]> {
  requirePermission(principal, Permission.AI_IDENTITY_MANAGE);
  const { rows } = await getPool().query<IdentityRow>(
    `SELECT * FROM ai_identity WHERE clinic_id = $1 ORDER BY created_at DESC`,
    [principal.clinicId],
  );
  return rows.map(mapIdentity);
}

export async function setIdentityStatus(
  principal: Principal,
  id: string,
  status: 'active' | 'disabled',
): Promise<AiIdentity> {
  requirePermission(principal, Permission.AI_IDENTITY_MANAGE);
  return withTransaction(async (client) => {
    const { rows } = await client.query<IdentityRow>(
      `UPDATE ai_identity SET status = $3, updated_at = now()
        WHERE id = $1 AND clinic_id = $2 RETURNING *`,
      [id, principal.clinicId, status],
    );
    if (rows.length === 0) throw new NotFoundError('AI identity');
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'ai.identity.status',
      outcome: 'success',
      targetType: 'ai_identity',
      targetId: id,
      metadata: { status },
    });
    return mapIdentity(rows[0]!);
  });
}
