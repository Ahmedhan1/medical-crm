import { getPool, type PoolClient } from '../../db/pool.js';
import { toDateString } from './dates.js';

type Runner = Pick<PoolClient, 'query'>;

export interface Territory {
  id: string;
  clinicId: string;
  code: string;
  name: string;
  parentTerritoryId: string | null;
  country: string;
  region: string | null;
  isActive: boolean;
  createdAt: string;
}

interface TerritoryRow {
  id: string;
  clinic_id: string;
  code: string;
  name: string;
  parent_territory_id: string | null;
  country: string;
  region: string | null;
  is_active: boolean;
  created_at: string;
}

function mapTerritory(row: TerritoryRow): Territory {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    code: row.code,
    name: row.name,
    parentTerritoryId: row.parent_territory_id,
    country: row.country,
    region: row.region,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export async function insertTerritory(
  runner: Runner,
  input: {
    clinicId: string;
    code: string;
    name: string;
    parentTerritoryId: string | null;
    country: string;
    region: string | null;
    createdBy: string;
  },
): Promise<Territory> {
  const { rows } = await runner.query<TerritoryRow>(
    `INSERT INTO territory (clinic_id, code, name, parent_territory_id, country, region, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.clinicId,
      input.code,
      input.name,
      input.parentTerritoryId,
      input.country,
      input.region,
      input.createdBy,
    ],
  );
  return mapTerritory(rows[0]!);
}

export async function getTerritoryById(
  clinicId: string,
  id: string,
  runner: Runner = getPool(),
): Promise<Territory | null> {
  const { rows } = await runner.query<TerritoryRow>(
    `SELECT * FROM territory WHERE id = $1 AND clinic_id = $2`,
    [id, clinicId],
  );
  return rows[0] ? mapTerritory(rows[0]) : null;
}

export async function listTerritories(clinicId: string, ids: string[] | null): Promise<Territory[]> {
  const { rows } = await getPool().query<TerritoryRow>(
    `SELECT * FROM territory
      WHERE clinic_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2))
      ORDER BY code`,
    [clinicId, ids],
  );
  return rows.map(mapTerritory);
}

export interface TerritoryAssignment {
  id: string;
  territoryId: string;
  territoryCode: string;
  territoryName: string;
  userId: string;
  assignmentRole: 'primary_rep' | 'backup_rep' | 'manager';
  validFrom: string;
  validTo: string | null;
}

export async function insertAssignment(
  runner: Runner,
  input: {
    clinicId: string;
    territoryId: string;
    userId: string;
    assignmentRole: TerritoryAssignment['assignmentRole'];
    validFrom: string | null;
    validTo: string | null;
    createdBy: string;
  },
): Promise<TerritoryAssignment> {
  const { rows } = await runner.query<{
    id: string;
    territory_id: string;
    user_id: string;
    assignment_role: TerritoryAssignment['assignmentRole'];
    valid_from: Date | string;
    valid_to: Date | string | null;
  }>(
    `INSERT INTO territory_assignment
       (clinic_id, territory_id, user_id, assignment_role, valid_from, valid_to, created_by)
     VALUES ($1,$2,$3,$4, coalesce($5::date, current_date), $6, $7)
     RETURNING *`,
    [
      input.clinicId,
      input.territoryId,
      input.userId,
      input.assignmentRole,
      input.validFrom,
      input.validTo,
      input.createdBy,
    ],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    territoryId: row.territory_id,
    territoryCode: '',
    territoryName: '',
    userId: row.user_id,
    assignmentRole: row.assignment_role,
    validFrom: toDateString(row.valid_from)!,
    validTo: toDateString(row.valid_to),
  };
}

export async function listAssignmentsForUser(
  clinicId: string,
  userId: string,
): Promise<TerritoryAssignment[]> {
  const { rows } = await getPool().query<{
    id: string;
    territory_id: string;
    code: string;
    name: string;
    user_id: string;
    assignment_role: TerritoryAssignment['assignmentRole'];
    valid_from: Date | string;
    valid_to: Date | string | null;
  }>(
    `SELECT a.id, a.territory_id, t.code, t.name, a.user_id, a.assignment_role,
            a.valid_from, a.valid_to
       FROM territory_assignment a
       JOIN territory t ON t.id = a.territory_id
      WHERE a.clinic_id = $1 AND a.user_id = $2
        AND a.valid_from <= current_date
        AND (a.valid_to IS NULL OR a.valid_to >= current_date)
      ORDER BY t.code`,
    [clinicId, userId],
  );
  return rows.map((r) => ({
    id: r.id,
    territoryId: r.territory_id,
    territoryCode: r.code,
    territoryName: r.name,
    userId: r.user_id,
    assignmentRole: r.assignment_role,
    validFrom: toDateString(r.valid_from)!,
    validTo: toDateString(r.valid_to),
  }));
}

export interface HcpTarget {
  id: string;
  hcpId: string;
  hcpName: string;
  territoryId: string;
  isTarget: boolean;
  tier: 'A' | 'B' | 'C' | 'D' | null;
  targetVisitsPerQuarter: number | null;
  assignedAt: string;
}

export async function upsertHcpTarget(
  runner: Runner,
  input: {
    clinicId: string;
    hcpId: string;
    territoryId: string;
    isTarget: boolean;
    tier: HcpTarget['tier'];
    targetVisitsPerQuarter: number | null;
    assignedBy: string;
  },
): Promise<void> {
  await runner.query(
    `INSERT INTO hcp_territory
       (clinic_id, hcp_id, territory_id, is_target, tier, target_visits_per_quarter, assigned_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (clinic_id, hcp_id, territory_id)
       DO UPDATE SET is_target = EXCLUDED.is_target,
                     tier = EXCLUDED.tier,
                     target_visits_per_quarter = EXCLUDED.target_visits_per_quarter,
                     assigned_by = EXCLUDED.assigned_by,
                     assigned_at = now()`,
    [
      input.clinicId,
      input.hcpId,
      input.territoryId,
      input.isTarget,
      input.tier,
      input.targetVisitsPerQuarter,
      input.assignedBy,
    ],
  );
}

export async function listTargets(
  clinicId: string,
  territoryIds: string[],
): Promise<HcpTarget[]> {
  if (territoryIds.length === 0) return [];
  const { rows } = await getPool().query<{
    id: string;
    hcp_id: string;
    full_name: string;
    territory_id: string;
    is_target: boolean;
    tier: HcpTarget['tier'];
    target_visits_per_quarter: number | null;
    assigned_at: string;
  }>(
    `SELECT ht.id, ht.hcp_id, h.full_name, ht.territory_id, ht.is_target, ht.tier,
            ht.target_visits_per_quarter, ht.assigned_at
       FROM hcp_territory ht
       JOIN hcp h ON h.id = ht.hcp_id
      WHERE ht.clinic_id = $1 AND ht.territory_id = ANY($2) AND h.status <> 'merged'
      ORDER BY ht.tier NULLS LAST, h.full_name`,
    [clinicId, territoryIds],
  );
  return rows.map((r) => ({
    id: r.id,
    hcpId: r.hcp_id,
    hcpName: r.full_name,
    territoryId: r.territory_id,
    isTarget: r.is_target,
    tier: r.tier,
    targetVisitsPerQuarter: r.target_visits_per_quarter,
    assignedAt: r.assigned_at,
  }));
}

/** Territories an HCP is targeted in (used by the 360 view and visit planning). */
export async function territoriesForHcp(
  clinicId: string,
  hcpId: string,
): Promise<Array<{ territoryId: string; code: string; name: string; tier: string | null }>> {
  const { rows } = await getPool().query<{
    territory_id: string;
    code: string;
    name: string;
    tier: string | null;
  }>(
    `SELECT ht.territory_id, t.code, t.name, ht.tier
       FROM hcp_territory ht
       JOIN territory t ON t.id = ht.territory_id
      WHERE ht.clinic_id = $1 AND ht.hcp_id = $2
      ORDER BY t.code`,
    [clinicId, hcpId],
  );
  return rows.map((r) => ({
    territoryId: r.territory_id,
    code: r.code,
    name: r.name,
    tier: r.tier,
  }));
}

/**
 * Close an open assignment by dating it.
 *
 * Territory scope is an AUTHORIZATION dimension, and until now it could only be
 * granted: `valid_to` existed on the table, `uq_territory_assignment_open` keyed
 * on it, and nothing in the service ever set it. A representative who moved
 * territory kept the old one for good, and the only way to revoke it was a
 * direct write to the database.
 *
 * Dating rather than deleting: who covered which territory when is the context
 * for every visit and call report already recorded against it.
 */
export async function endAssignment(
  runner: Runner,
  clinicId: string,
  assignmentId: string,
  validTo: string,
): Promise<TerritoryAssignment | null> {
  const { rows } = await runner.query<{
    id: string;
    territory_id: string;
    territory_code: string;
    territory_name: string;
    user_id: string;
    assignment_role: TerritoryAssignment['assignmentRole'];
    valid_from: Date | string;
    valid_to: Date | string | null;
  }>(
    `WITH updated AS (
       UPDATE territory_assignment
          SET valid_to = $3::date
        WHERE id = $1 AND clinic_id = $2 AND valid_to IS NULL
        RETURNING *
     )
     SELECT u.*, t.code AS territory_code, t.name AS territory_name
       FROM updated u
       JOIN territory t ON t.id = u.territory_id`,
    [assignmentId, clinicId, validTo],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    territoryId: row.territory_id,
    territoryCode: row.territory_code,
    territoryName: row.territory_name,
    userId: row.user_id,
    assignmentRole: row.assignment_role,
    validFrom: toDateString(row.valid_from)!,
    validTo: toDateString(row.valid_to),
  };
}

/** One assignment, for the service to check tenancy and open-ness before ending it. */
export async function getAssignmentById(
  clinicId: string,
  assignmentId: string,
  runner: Runner = getPool(),
): Promise<{ id: string; territoryId: string; userId: string; validTo: string | null } | null> {
  const { rows } = await runner.query<{
    id: string;
    territory_id: string;
    user_id: string;
    valid_to: Date | string | null;
  }>(
    `SELECT id, territory_id, user_id, valid_to
       FROM territory_assignment
      WHERE id = $1 AND clinic_id = $2`,
    [assignmentId, clinicId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    territoryId: row.territory_id,
    userId: row.user_id,
    validTo: toDateString(row.valid_to),
  };
}
