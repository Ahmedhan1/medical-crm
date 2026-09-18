import { getPool, type PoolClient } from '../../db/pool.js';
import { toDateString } from './dates.js';

type Runner = Pick<PoolClient, 'query'>;

/**
 * FIELD-FORCE repository (migration 0309).
 *
 * `field_rep_profile` is the employment and reporting record of a
 * representative: who they are in the field organisation, who they report to,
 * and whether they are currently active. It is deliberately NOT an identity
 * record — `app_user` remains the identity, and this table only describes that
 * user's role in the field force.
 *
 * GOVERNANCE: no statement here touches a clinical table (§45).
 */

export interface FieldRepProfile {
  id: string;
  clinicId: string;
  userId: string;
  userName: string | null;
  employeeRef: string | null;
  repRole: 'representative' | 'senior_representative' | 'district_manager' | 'regional_manager';
  status: 'active' | 'on_leave' | 'inactive';
  managerUserId: string | null;
  managerName: string | null;
  region: string | null;
  startDate: string;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProfileRow {
  id: string;
  clinic_id: string;
  user_id: string;
  user_name: string | null;
  employee_ref: string | null;
  rep_role: FieldRepProfile['repRole'];
  status: FieldRepProfile['status'];
  manager_user_id: string | null;
  manager_name: string | null;
  region: string | null;
  start_date: Date | string;
  end_date: Date | string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_PROFILE = `p.*,
         u.display_name AS user_name,
         m.display_name AS manager_name
    FROM field_rep_profile p
    JOIN app_user u ON u.id = p.user_id
    LEFT JOIN app_user m ON m.id = p.manager_user_id`;

function mapProfile(row: ProfileRow): FieldRepProfile {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    userId: row.user_id,
    userName: row.user_name,
    employeeRef: row.employee_ref,
    repRole: row.rep_role,
    status: row.status,
    managerUserId: row.manager_user_id,
    managerName: row.manager_name,
    region: row.region,
    startDate: toDateString(row.start_date)!,
    endDate: toDateString(row.end_date),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertProfileInput {
  clinicId: string;
  userId: string;
  employeeRef: string | null;
  repRole: FieldRepProfile['repRole'];
  status: FieldRepProfile['status'];
  managerUserId: string | null;
  region: string | null;
  startDate: string;
  endDate: string | null;
  createdBy: string;
}

/**
 * Create the profile, or update it if this user already has one.
 *
 * Upsert rather than insert-or-409: a field force is re-imported from HR, and
 * `UNIQUE (clinic_id, user_id)` means the second import of the same person is a
 * correction, not a conflict.
 */
export async function upsertProfile(
  runner: Runner,
  input: UpsertProfileInput,
): Promise<FieldRepProfile> {
  const { rows } = await runner.query<ProfileRow>(
    `WITH saved AS (
       INSERT INTO field_rep_profile
         (clinic_id, user_id, employee_ref, rep_role, status, manager_user_id, region,
          start_date, end_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (clinic_id, user_id) DO UPDATE
         SET employee_ref = EXCLUDED.employee_ref,
             rep_role = EXCLUDED.rep_role,
             status = EXCLUDED.status,
             manager_user_id = EXCLUDED.manager_user_id,
             region = EXCLUDED.region,
             start_date = EXCLUDED.start_date,
             end_date = EXCLUDED.end_date,
             updated_at = now()
       RETURNING *
     )
     SELECT p.*, u.display_name AS user_name, m.display_name AS manager_name
       FROM saved p
       JOIN app_user u ON u.id = p.user_id
       LEFT JOIN app_user m ON m.id = p.manager_user_id`,
    [
      input.clinicId,
      input.userId,
      input.employeeRef,
      input.repRole,
      input.status,
      input.managerUserId,
      input.region,
      input.startDate,
      input.endDate,
      input.createdBy,
    ],
  );
  return mapProfile(rows[0]!);
}

export async function getProfileByUser(
  clinicId: string,
  userId: string,
  runner: Runner = getPool(),
): Promise<FieldRepProfile | null> {
  const { rows } = await runner.query<ProfileRow>(
    `SELECT ${SELECT_PROFILE} WHERE p.clinic_id = $1 AND p.user_id = $2`,
    [clinicId, userId],
  );
  return rows[0] ? mapProfile(rows[0]) : null;
}

export interface ListProfileFilter {
  managerUserId: string | null;
  status: FieldRepProfile['status'] | null;
  repRole: FieldRepProfile['repRole'] | null;
  /** When set, restricts the result to these user ids — the caller's subtree. */
  userIds: string[] | null;
  limit: number;
}

export async function listProfiles(
  clinicId: string,
  filter: ListProfileFilter,
  runner: Runner = getPool(),
): Promise<FieldRepProfile[]> {
  // An empty subtree means "nobody", never "everybody".
  if (filter.userIds !== null && filter.userIds.length === 0) return [];
  const { rows } = await runner.query<ProfileRow>(
    `SELECT ${SELECT_PROFILE}
      WHERE p.clinic_id = $1
        AND ($2::uuid IS NULL OR p.manager_user_id = $2)
        AND ($3::text IS NULL OR p.status = $3)
        AND ($4::text IS NULL OR p.rep_role = $4)
        AND ($5::uuid[] IS NULL OR p.user_id = ANY($5))
      ORDER BY u.display_name
      LIMIT $6`,
    [
      clinicId,
      filter.managerUserId,
      filter.status,
      filter.repRole,
      filter.userIds,
      filter.limit,
    ],
  );
  return rows.map(mapProfile);
}
