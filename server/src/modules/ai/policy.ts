import { getPool, withTransaction } from '../../db/pool.js';
import { auditTx } from '../governance/audit.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { Permission } from '../governance/permissions.js';
import { DataClass, parseDataClass, severity, type DataClass as DataClassType } from './classification.js';

/**
 * AI data policy engine (program Phase 4 / this increment).
 *
 * Given a classified AI input and a tenant's AI policy, decide how the request
 * may be routed. This is the gate that prevents PHI from silently reaching a
 * cloud model.
 *
 * Decisions (the full vocabulary from the directive; this increment implements
 * the routing-critical three and reserves the transforms for a later increment):
 *   ALLOW_LOCAL     — process on-box only (default-safe)
 *   ALLOW_CLOUD     — a cloud provider is permitted for this data class
 *   DENY            — refuse the request (fail-closed)
 *   REDACT/MINIMIZE/REQUIRE_REVIEW — reserved (not yet emitted)
 */
export const PolicyDecision = {
  ALLOW_LOCAL: 'allow_local',
  ALLOW_CLOUD: 'allow_cloud',
  REDACT: 'redact',
  MINIMIZE: 'minimize',
  REQUIRE_REVIEW: 'require_review',
  DENY: 'deny',
} as const;
export type PolicyDecision = (typeof PolicyDecision)[keyof typeof PolicyDecision];

export interface TenantAiPolicy {
  clinicId: string;
  allowCloud: boolean;
  cloudMaxClass: DataClassType;
}

/**
 * The effective policy for a clinic. A MISSING row is fail-closed: cloud is not
 * allowed, so every request runs locally. Callers never get a permissive
 * default by omission.
 */
export async function getTenantAiPolicy(clinicId: string): Promise<TenantAiPolicy> {
  const { rows } = await getPool().query<{ allow_cloud: boolean; cloud_max_class: string }>(
    `SELECT allow_cloud, cloud_max_class FROM tenant_ai_policy WHERE clinic_id = $1`,
    [clinicId],
  );
  const row = rows[0];
  if (!row) {
    return { clinicId, allowCloud: false, cloudMaxClass: DataClass.OPERATIONAL };
  }
  return {
    clinicId,
    allowCloud: row.allow_cloud,
    cloudMaxClass: parseDataClass(row.cloud_max_class) ?? DataClass.OPERATIONAL,
  };
}

/**
 * Decide routing for an input of class `inputClass` under `policy`. Pure and
 * deterministic. Fail-closed everywhere:
 *   - HIGHLY_RESTRICTED never leaves the box, regardless of tenant policy.
 *   - If the tenant has not opted into cloud → local only.
 *   - Otherwise cloud is allowed only when the input is no more sensitive than
 *     the tenant's cloud ceiling; more sensitive data stays local.
 */
export function decide(inputClass: DataClassType, policy: TenantAiPolicy): PolicyDecision {
  // The most sensitive class is on-box only, always.
  if (inputClass === DataClass.HIGHLY_RESTRICTED) return PolicyDecision.ALLOW_LOCAL;
  if (!policy.allowCloud) return PolicyDecision.ALLOW_LOCAL;
  if (severity(inputClass) <= severity(policy.cloudMaxClass)) return PolicyDecision.ALLOW_CLOUD;
  return PolicyDecision.ALLOW_LOCAL;
}

/** Does a decision permit off-box (cloud) processing? */
export function permitsCloud(decision: PolicyDecision): boolean {
  return decision === PolicyDecision.ALLOW_CLOUD;
}

// --- Admin: read/set the tenant AI policy ----------------------------------

export async function readTenantAiPolicy(principal: Principal): Promise<TenantAiPolicy> {
  requirePermission(principal, Permission.AI_POLICY_MANAGE);
  return getTenantAiPolicy(principal.clinicId);
}

export interface SetTenantAiPolicyInput {
  allowCloud?: boolean;
  cloudMaxClass?: DataClassType;
}

export async function setTenantAiPolicy(
  principal: Principal,
  input: SetTenantAiPolicyInput,
): Promise<TenantAiPolicy> {
  requirePermission(principal, Permission.AI_POLICY_MANAGE);
  const allowCloud = input.allowCloud ?? false;
  const cloudMaxClass = input.cloudMaxClass ?? DataClass.OPERATIONAL;

  return withTransaction(async (client) => {
    const { rows } = await client.query<{ allow_cloud: boolean; cloud_max_class: string }>(
      `INSERT INTO tenant_ai_policy (clinic_id, allow_cloud, cloud_max_class, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (clinic_id) DO UPDATE SET
         allow_cloud = EXCLUDED.allow_cloud,
         cloud_max_class = EXCLUDED.cloud_max_class,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING allow_cloud, cloud_max_class`,
      [principal.clinicId, allowCloud, cloudMaxClass, principal.userId],
    );
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'ai.policy.set',
      outcome: 'success',
      targetType: 'tenant_ai_policy',
      targetId: principal.clinicId,
      metadata: { allowCloud, cloudMaxClass },
    });
    return {
      clinicId: principal.clinicId,
      allowCloud: rows[0]!.allow_cloud,
      cloudMaxClass: parseDataClass(rows[0]!.cloud_max_class) ?? DataClass.OPERATIONAL,
    };
  });
}
