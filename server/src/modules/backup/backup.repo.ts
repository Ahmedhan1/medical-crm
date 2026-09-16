import { getPool } from '../../db/pool.js';

export interface BackupRun {
  id: string;
  kind: 'manual' | 'scheduled';
  status: 'in_progress' | 'completed' | 'failed' | 'verified';
  filename: string | null;
  byteSize: number | null;
  checksumSha256: string | null;
  encrypted: boolean;
  migrationsApplied: number | null;
  tableCount: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  verifiedAt: string | null;
  createdBy: string | null;
}

interface Row {
  id: string;
  kind: BackupRun['kind'];
  status: BackupRun['status'];
  filename: string | null;
  byte_size: string | null;
  checksum_sha256: string | null;
  encrypted: boolean;
  migrations_applied: number | null;
  table_count: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  verified_at: string | null;
  created_by: string | null;
}

function map(r: Row): BackupRun {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    filename: r.filename,
    byteSize: r.byte_size === null ? null : Number(r.byte_size),
    checksumSha256: r.checksum_sha256,
    encrypted: r.encrypted,
    migrationsApplied: r.migrations_applied,
    tableCount: r.table_count,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    verifiedAt: r.verified_at,
    createdBy: r.created_by,
  };
}

export async function createRun(
  kind: BackupRun['kind'],
  createdBy: string | null,
): Promise<BackupRun> {
  const { rows } = await getPool().query<Row>(
    `INSERT INTO backup_run (kind, status, created_by) VALUES ($1, 'in_progress', $2) RETURNING *`,
    [kind, createdBy],
  );
  return map(rows[0]!);
}

export async function markCompleted(
  id: string,
  meta: {
    filename: string;
    byteSize: number;
    checksumSha256: string;
    encrypted: boolean;
    migrationsApplied: number;
    tableCount: number;
  },
): Promise<void> {
  await getPool().query(
    `UPDATE backup_run
        SET status='completed', filename=$2, byte_size=$3, checksum_sha256=$4,
            encrypted=$5, migrations_applied=$6, table_count=$7, finished_at=now()
      WHERE id=$1`,
    [
      id,
      meta.filename,
      meta.byteSize,
      meta.checksumSha256,
      meta.encrypted,
      meta.migrationsApplied,
      meta.tableCount,
    ],
  );
}

export async function markFailed(id: string, error: string): Promise<void> {
  await getPool().query(
    `UPDATE backup_run SET status='failed', error=$2, finished_at=now() WHERE id=$1`,
    [id, error.slice(0, 500)],
  );
}

export async function markVerified(id: string): Promise<void> {
  await getPool().query(
    `UPDATE backup_run SET status='verified', verified_at=now() WHERE id=$1`,
    [id],
  );
}

export async function getRun(id: string): Promise<BackupRun | null> {
  const { rows } = await getPool().query<Row>(`SELECT * FROM backup_run WHERE id=$1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

export async function listRuns(limit = 50): Promise<BackupRun[]> {
  const { rows } = await getPool().query<Row>(
    `SELECT * FROM backup_run ORDER BY started_at DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(map);
}

/** All runs that produced an artifact (completed or verified), newest first. */
export async function listRestorableRuns(): Promise<BackupRun[]> {
  const { rows } = await getPool().query<Row>(
    `SELECT * FROM backup_run WHERE status IN ('completed','verified')
      ORDER BY started_at DESC`,
  );
  return rows.map(map);
}

export async function deleteRun(id: string): Promise<void> {
  await getPool().query(`DELETE FROM backup_run WHERE id=$1`, [id]);
}
