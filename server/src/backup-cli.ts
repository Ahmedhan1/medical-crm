import { config } from './config/env.js';
import { closePool } from './db/pool.js';
import {
  createBackup,
  listBackups,
  verifyBackup,
  restoreBackup,
  pruneBackups,
} from './modules/backup/backup.service.js';

/**
 * MEDCORE backup operator CLI (platform, Agent 1).
 *
 *   tsx src/backup-cli.ts backup
 *   tsx src/backup-cli.ts list
 *   tsx src/backup-cli.ts verify <id>
 *   tsx src/backup-cli.ts prune
 *   tsx src/backup-cli.ts restore <id> --target <postgres-url> [--yes]
 *
 * RESTORE is destructive and intentionally CLI-only (never HTTP). Restoring over
 * the live database requires --yes; a scratch/target URL can be given for a
 * verification restore.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'backup': {
      const run = await createBackup(null, 'manual');
      console.log(`[backup] ${run.status} ${run.filename} (${run.byteSize} bytes, ${run.tableCount} tables)`);
      break;
    }
    case 'list': {
      for (const b of await listBackups(50)) {
        console.log(`${b.startedAt}  ${b.status.padEnd(10)} ${b.id}  ${b.filename ?? ''}`);
      }
      break;
    }
    case 'verify': {
      const id = process.argv[3];
      if (!id) throw new Error('usage: verify <id>');
      const r = await verifyBackup(null, id);
      console.log(`[verify] ok=${r.ok} checksum=${r.checksumMatches} archive=${r.archiveReadable}`);
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case 'prune': {
      const r = await pruneBackups(null);
      console.log(`[prune] kept=${r.kept} removed=${r.removed}`);
      break;
    }
    case 'restore': {
      const id = process.argv[3];
      if (!id) throw new Error('usage: restore <id> --target <url> [--yes]');
      const target = arg('target') ?? config().databaseUrl;
      const isLive = target === config().databaseUrl;
      if (isLive && !has('yes')) {
        throw new Error(
          'Refusing to restore over the live database without --yes. ' +
            'Pass --target <url> to restore into a scratch database instead.',
        );
      }
      await restoreBackup(target, id, null);
      console.log(`[restore] completed into ${new URL(target).pathname.replace(/^\//, '')}`);
      break;
    }
    default:
      console.log('commands: backup | list | verify <id> | prune | restore <id> --target <url> [--yes]');
      process.exitCode = 2;
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('[backup-cli] failed:', err instanceof Error ? err.message : err);
    await closePool();
    process.exit(1);
  });
