import { mkdir, stat, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../../config/env.js';
import { getPool } from '../../db/pool.js';
import { audit } from '../governance/audit.js';
import { NotFoundError } from '../../domain/errors.js';
import {
  pgDump,
  pgRestore,
  pgArchiveIsReadable,
  sha256File,
  encryptFile,
  decryptFile,
} from './pg.js';
import {
  createRun,
  deleteRun,
  getRun,
  listRestorableRuns,
  listRuns,
  markCompleted,
  markFailed,
  markVerified,
  type BackupRun,
} from './backup.repo.js';

export type { BackupRun } from './backup.repo.js';

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}

async function countMigrationsAndTables(): Promise<{ migrations: number; tables: number }> {
  const pool = getPool();
  const m = await pool.query<{ n: string }>('SELECT count(*)::text n FROM schema_migrations');
  const t = await pool.query<{ n: string }>(
    `SELECT count(*)::text n FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'`,
  );
  return { migrations: Number(m.rows[0]!.n), tables: Number(t.rows[0]!.n) };
}

/**
 * Create a database backup: pg_dump → (optional AES-256-GCM encrypt) → checksum,
 * recording a `backup_run` row and an audit entry. Returns the completed run.
 * The artifact never contains a credential; the run row never contains PHI.
 */
export async function createBackup(
  actorId: string | null,
  kind: 'manual' | 'scheduled' = 'manual',
): Promise<BackupRun> {
  const cfg = config();
  const dir = cfg.backup.dir;
  await mkdir(dir, { recursive: true });

  const run = await createRun(kind, actorId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `medcore-${stamp}-${randomBytes(4).toString('hex')}.dump`;
  const encrypted = Boolean(cfg.backup.encryptionKey);
  const finalName = encrypted ? `${base}.enc` : base;
  const finalPath = join(dir, finalName);
  const plainPath = encrypted ? join(dir, `${base}.tmp`) : finalPath;

  try {
    await pgDump(cfg.databaseUrl, plainPath);
    if (encrypted) {
      await encryptFile(plainPath, finalPath, cfg.backup.encryptionKey!);
      await unlink(plainPath).catch(() => {});
    }
    const { size } = await stat(finalPath);
    const checksum = await sha256File(finalPath);
    const counts = await countMigrationsAndTables();
    await markCompleted(run.id, {
      filename: finalName,
      byteSize: size,
      checksumSha256: checksum,
      encrypted,
      migrationsApplied: counts.migrations,
      tableCount: counts.tables,
    });
    await audit({
      actorId,
      action: 'backup.create',
      outcome: 'success',
      targetType: 'backup_run',
      targetId: run.id,
      metadata: { kind, encrypted, tableCount: counts.tables },
    });
    return (await getRun(run.id))!;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markFailed(run.id, msg);
    await audit({
      actorId,
      action: 'backup.create',
      outcome: 'error',
      targetType: 'backup_run',
      targetId: run.id,
      metadata: { kind },
    });
    // Best-effort cleanup of a partial artifact.
    await unlink(finalPath).catch(() => {});
    await unlink(plainPath).catch(() => {});
    throw err;
  }
}

export interface VerifyResult {
  ok: boolean;
  checksumMatches: boolean;
  archiveReadable: boolean;
}

/**
 * Verify a backup artifact WITHOUT restoring it: the file exists, its checksum
 * matches what was recorded (integrity), and it is a readable pg archive
 * (decrypting first if needed). A backup is not "valid" just because pg_dump
 * exited 0 — this proves the artifact is intact and parseable.
 */
export async function verifyBackup(actorId: string | null, id: string): Promise<VerifyResult> {
  const cfg = config();
  const run = await getRun(id);
  if (!run || !run.filename) throw new NotFoundError('Backup');
  const path = join(cfg.backup.dir, run.filename);

  let checksumMatches = false;
  let archiveReadable = false;
  let tmp: string | null = null;
  try {
    checksumMatches = (await sha256File(path)) === run.checksumSha256;
    let toInspect = path;
    if (run.encrypted) {
      if (!cfg.backup.encryptionKey) throw new Error('encryption key not configured');
      tmp = join(cfg.backup.dir, `verify-${randomBytes(4).toString('hex')}.tmp`);
      await decryptFile(path, tmp, cfg.backup.encryptionKey);
      toInspect = tmp;
    }
    archiveReadable = await pgArchiveIsReadable(toInspect);
  } finally {
    if (tmp) await unlink(tmp).catch(() => {});
  }

  const ok = checksumMatches && archiveReadable;
  if (ok) await markVerified(id);
  await audit({
    actorId,
    action: 'backup.verify',
    outcome: ok ? 'success' : 'error',
    targetType: 'backup_run',
    targetId: id,
    metadata: { checksumMatches, archiveReadable },
  });
  return { ok, checksumMatches, archiveReadable };
}

export function listBackups(limit = 50): Promise<BackupRun[]> {
  return listRuns(limit);
}

/**
 * Restore a backup artifact into a target database (destructive). This is an
 * OPERATOR action invoked from the CLI or tests — never exposed over HTTP — so a
 * web session can never overwrite the live database. The caller chooses the
 * target (e.g. a scratch DB for verification, or the live DB during recovery).
 */
export async function restoreBackup(
  targetDatabaseUrl: string,
  id: string,
  actorId: string | null = null,
): Promise<void> {
  const cfg = config();
  const run = await getRun(id);
  if (!run || !run.filename) throw new NotFoundError('Backup');
  const path = join(cfg.backup.dir, run.filename);

  let tmp: string | null = null;
  try {
    let toRestore = path;
    if (run.encrypted) {
      if (!cfg.backup.encryptionKey) throw new Error('encryption key not configured');
      tmp = join(cfg.backup.dir, `restore-${randomBytes(4).toString('hex')}.tmp`);
      await decryptFile(path, tmp, cfg.backup.encryptionKey);
      toRestore = tmp;
    }
    await pgRestore(targetDatabaseUrl, toRestore);
    await audit({
      actorId,
      action: 'backup.restore',
      outcome: 'success',
      targetType: 'backup_run',
      targetId: id,
      // Never record the target credential; note only that a restore happened.
      metadata: { restored: true },
    });
  } finally {
    if (tmp) await rm(tmp).catch(() => {});
  }
}

/**
 * Pure retention selector (GFS): given runs newest-first, keep the newest per
 * day/week/month up to the configured counts; everything else is removable.
 * Kept pure so the rotation rule is exhaustively unit-tested.
 */
export function selectForRetention(
  runs: Array<{ id: string; startedAt: string }>,
  policy: RetentionPolicy,
): { keep: string[]; remove: string[] } {
  const keep = new Set<string>();
  const seen = { day: new Set<string>(), week: new Set<string>(), month: new Set<string>() };

  const sorted = [...runs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  for (const r of sorted) {
    const d = new Date(r.startedAt);
    const dayKey = d.toISOString().slice(0, 10);
    const monthKey = d.toISOString().slice(0, 7);
    const weekKey = isoWeekKey(d);
    if (seen.day.size < policy.daily && !seen.day.has(dayKey)) {
      seen.day.add(dayKey);
      keep.add(r.id);
    }
    if (seen.week.size < policy.weekly && !seen.week.has(weekKey)) {
      seen.week.add(weekKey);
      keep.add(r.id);
    }
    if (seen.month.size < policy.monthly && !seen.month.has(monthKey)) {
      seen.month.add(monthKey);
      keep.add(r.id);
    }
  }
  const remove = sorted.filter((r) => !keep.has(r.id)).map((r) => r.id);
  return { keep: [...keep], remove };
}

/**
 * Apply the configured retention policy: keep the GFS selection, delete the
 * artifact files and ledger rows of everything else. Returns the counts.
 */
export async function pruneBackups(
  actorId: string | null = null,
): Promise<{ kept: number; removed: number }> {
  const cfg = config();
  const runs = await listRestorableRuns();
  const { keep, remove } = selectForRetention(
    runs.map((r) => ({ id: r.id, startedAt: r.startedAt })),
    {
      daily: cfg.backup.retainDaily,
      weekly: cfg.backup.retainWeekly,
      monthly: cfg.backup.retainMonthly,
    },
  );
  const byId = new Map(runs.map((r) => [r.id, r]));
  for (const id of remove) {
    const r = byId.get(id);
    if (r?.filename) await rm(join(cfg.backup.dir, r.filename)).catch(() => {});
    await deleteRun(id);
  }
  if (remove.length > 0) {
    await audit({
      actorId,
      action: 'backup.prune',
      outcome: 'success',
      targetType: 'backup_run',
      metadata: { kept: keep.length, removed: remove.length },
    });
  }
  return { kept: keep.length, removed: remove.length };
}

function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
