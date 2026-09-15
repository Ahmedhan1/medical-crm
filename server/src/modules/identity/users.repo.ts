import { getPool } from '../../db/pool.js';
import type { Permission } from '../governance/permissions.js';

export interface UserRow {
  id: string;
  clinicId: string;
  username: string;
  displayName: string;
  passwordHash: string;
  isActive: boolean;
}

export interface UserWithAccess extends UserRow {
  roles: string[];
  permissions: Permission[];
}

/** Look up an active user by clinic + username, with roles and permissions. */
export async function findUserForLogin(
  clinicId: string,
  username: string,
): Promise<UserWithAccess | null> {
  const { rows } = await getPool().query<{
    id: string;
    clinic_id: string;
    username: string;
    display_name: string;
    password_hash: string;
    is_active: boolean;
    roles: string[] | null;
    permissions: string[] | null;
  }>(
    `SELECT u.id, u.clinic_id, u.username, u.display_name, u.password_hash, u.is_active,
            array_remove(array_agg(DISTINCT r.key), NULL) AS roles,
            array_remove(array_agg(DISTINCT rp.permission_key), NULL) AS permissions
       FROM app_user u
       LEFT JOIN user_role ur ON ur.user_id = u.id
       LEFT JOIN role r ON r.id = ur.role_id
       LEFT JOIN role_permission rp ON rp.role_id = r.id
      WHERE u.clinic_id = $1 AND u.username = $2
      GROUP BY u.id`,
    [clinicId, username],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    clinicId: row.clinic_id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    isActive: row.is_active,
    roles: row.roles ?? [],
    permissions: (row.permissions ?? []) as Permission[],
  };
}

/** Resolve a live session token hash to its principal data. */
export async function findUserBySessionHash(tokenHash: string): Promise<UserWithAccess | null> {
  const { rows } = await getPool().query<{
    id: string;
    clinic_id: string;
    username: string;
    display_name: string;
    password_hash: string;
    is_active: boolean;
    roles: string[] | null;
    permissions: string[] | null;
  }>(
    `SELECT u.id, u.clinic_id, u.username, u.display_name, u.password_hash, u.is_active,
            array_remove(array_agg(DISTINCT r.key), NULL) AS roles,
            array_remove(array_agg(DISTINCT rp.permission_key), NULL) AS permissions
       FROM session s
       JOIN app_user u ON u.id = s.user_id
       LEFT JOIN user_role ur ON ur.user_id = u.id
       LEFT JOIN role r ON r.id = ur.role_id
       LEFT JOIN role_permission rp ON rp.role_id = r.id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.is_active = true
      GROUP BY u.id`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    clinicId: row.clinic_id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    isActive: row.is_active,
    roles: row.roles ?? [],
    permissions: (row.permissions ?? []) as Permission[],
  };
}
