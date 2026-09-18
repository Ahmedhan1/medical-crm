#!/usr/bin/env node
/**
 * MEDCORE BOX bootstrap — the first-run installer logic, in plain Node (no extra
 * dependency) so it runs identically on Windows, Linux and macOS. `vendor.bat`
 * (Windows) and `medcorectl.mjs` call into it. It is idempotent: re-running never
 * destroys existing data or an existing config.
 *
 * Steps: preflight → generate config (secure secrets) → initialize database →
 * run migrations → bootstrap the admin account → health check. Every step logs to
 * install/logs/bootstrap-<ts>.log for support. On a failing step it stops and
 * prints a clear, secret-free message; it never leaves a half-migrated DB (the
 * migration runner is transactional per migration).
 *
 * Usage:
 *   node install/bootstrap.mjs --check          # preflight only, no changes
 *   node install/bootstrap.mjs                   # full install (idempotent)
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server');
const ENV_FILE = join(SERVER, '.env');
const LOG_DIR = join(ROOT, 'install', 'logs');
const LOG_FILE = join(LOG_DIR, `bootstrap-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

const CHECK_ONLY = process.argv.includes('--check');

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  // eslint-disable-next-line no-console
  console.log(stamped);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, stamped + '\n');
  } catch {
    /* logging is best-effort */
  }
}
function fail(msg) {
  log(`ERROR: ${msg}`);
  log('Bootstrap stopped. No destructive action was taken. See the log above.');
  process.exit(1);
}

// --- Step 1: preflight ------------------------------------------------------
function preflight() {
  log('Preflight: checking prerequisites…');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) fail(`Node ${process.versions.node} found; MEDCORE needs Node 20+ (22 recommended).`);
  log(`  node ${process.versions.node} OK`);

  // pg_dump / pg_restore are needed for backup/restore; warn if missing.
  const pgDump = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (pgDump.status === 0) log(`  ${pgDump.stdout.trim()} OK`);
  else log('  WARNING: pg_dump not found on PATH — backup/restore will need the PostgreSQL client tools.');

  if (!existsSync(join(SERVER, 'package.json'))) fail('server/ not found — run from the MEDCORE root.');
  log('  server package present OK');
  return true;
}

// --- Step 2: config ---------------------------------------------------------
function generateSecret(bytes = 48) {
  return randomBytes(bytes).toString('base64url');
}
function ensureConfig() {
  if (existsSync(ENV_FILE)) {
    log('Config: server/.env already exists — keeping it (idempotent, secrets preserved).');
    return;
  }
  log('Config: generating server/.env with fresh secrets…');
  const dbUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/medcore';
  const licenseDir = process.env.LICENSE_DIR ?? join(ROOT, 'state', 'license');
  const backupDir = process.env.BACKUP_DIR ?? join(ROOT, 'state', 'backups');
  const env = [
    'NODE_ENV=production',
    'HOST=0.0.0.0',
    'PORT=4000',
    `DATABASE_URL=${dbUrl}`,
    `AUTH_PEPPER=${generateSecret()}`,
    `BACKUP_DIR=${backupDir}`,
    `BACKUP_ENCRYPTION_KEY=${generateSecret()}`,
    `LICENSE_DIR=${licenseDir}`,
    '# LICENSE_PUBLIC_KEY is pinned by the vendor at packaging time.',
    '',
  ].join('\n');
  if (CHECK_ONLY) {
    log('  (--check) would write server/.env with generated AUTH_PEPPER / BACKUP_ENCRYPTION_KEY.');
    return;
  }
  mkdirSync(dirname(ENV_FILE), { recursive: true });
  writeFileSync(ENV_FILE, env, { mode: 0o600 });
  mkdirSync(licenseDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  log('  server/.env written (0600). Secrets were generated locally and never printed.');
}

/** Load the generated/existing .env into this process so the migrate/seed steps
 *  (spawned children) inherit DATABASE_URL, AUTH_PEPPER, etc. */
function loadEnv() {
  try {
    if (existsSync(ENV_FILE) && typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(ENV_FILE);
    }
  } catch {
    /* if unreadable, the operator's shell env is used as-is */
  }
}

// --- Steps 3–4: database + migrations --------------------------------------
function runServer(cmd, extraEnv = {}) {
  const res = spawnSync('npm', ['run', cmd], {
    cwd: SERVER,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
  return res.status === 0;
}
function migrate() {
  log('Database: applying migrations (transactional, idempotent)…');
  if (CHECK_ONLY) {
    log('  (--check) skipping migrate.');
    return;
  }
  if (!runServer('migrate')) fail('Migration failed — see output above. The DB is not left half-migrated.');
  log('  migrations applied OK');
}

// --- Step 5: admin bootstrap ------------------------------------------------
function seedAdmin() {
  log('Admin: ensuring a bootstrap clinic + admin account exists…');
  if (CHECK_ONLY) {
    log('  (--check) skipping admin bootstrap.');
    return;
  }
  if (!runServer('seed:admin')) fail('Admin bootstrap failed — see output above.');
  log('  admin bootstrap OK (the one-time password was printed by the seeder; store it securely).');
}

// --- Step 6: health check ---------------------------------------------------
function healthCheck() {
  log('Health: run `node install/medcorectl.mjs health` after starting the service to confirm green.');
}

log(`MEDCORE bootstrap starting (${CHECK_ONLY ? 'preflight/--check' : 'full install'})`);
log(`Root: ${ROOT}`);
preflight();
ensureConfig();
loadEnv();
migrate();
seedAdmin();
healthCheck();
log(CHECK_ONLY ? 'Preflight complete — prerequisites look OK.' : 'Bootstrap complete. Start MEDCORE and open the onboarding screen.');
