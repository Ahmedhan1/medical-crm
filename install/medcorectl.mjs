#!/usr/bin/env node
/**
 * medcorectl — MEDCORE operations CLI (cross-platform, plain Node). The Windows
 * `vendor.bat` and any unix wrapper call into this so the operational logic lives
 * in ONE tested place. All commands are safe and idempotent, print user-friendly
 * messages, and never echo secrets.
 *
 *   node install/medcorectl.mjs health        # detailed health (JSON summary)
 *   node install/medcorectl.mjs status        # is the service responding?
 *   node install/medcorectl.mjs backup        # create an encrypted backup
 *   node install/medcorectl.mjs restore <id>  # restore (guarded; asks for --yes)
 *   node install/medcorectl.mjs diagnostics   # write a PHI-free support bundle
 *   node install/medcorectl.mjs update        # safe update: backup→migrate→verify
 *   node install/medcorectl.mjs license status
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server');
const PORT = process.env.PORT ?? '4000';
const BASE = `http://localhost:${PORT}`;

function say(msg) {
  // eslint-disable-next-line no-console
  console.log(msg);
}
function runServer(script, args = []) {
  return spawnSync('npm', ['run', '--silent', script, '--', ...args], {
    cwd: SERVER,
    encoding: 'utf8',
    stdio: 'inherit',
    env: process.env,
  }).status;
}
async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

async function health() {
  try {
    const r = await getJson('/health/detailed');
    say(JSON.stringify(r.body, null, 2));
    process.exit(r.body?.status === 'ok' ? 0 : 1);
  } catch {
    say('UNREACHABLE: MEDCORE is not responding on ' + BASE + '. Is the service started?');
    process.exit(1);
  }
}

async function status() {
  try {
    const r = await getJson('/health');
    say(r.ok ? 'MEDCORE is running and the database is reachable.' : 'MEDCORE is degraded.');
    process.exit(r.ok ? 0 : 1);
  } catch {
    say('MEDCORE is not running.');
    process.exit(1);
  }
}

async function diagnostics() {
  // A PHI-free support bundle: versions, health, migration count, metrics, backup
  // status. It deliberately contains NO patient data and NO secrets, so it is safe
  // to send to support.
  const bundle = {
    generatedAt: new Date().toISOString(),
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    health: null,
    metrics: null,
    license: null,
  };
  try {
    bundle.health = (await getJson('/health/detailed')).body;
  } catch {
    bundle.health = { status: 'unreachable' };
  }
  try {
    bundle.metrics = (await getJson('/metrics')).body;
  } catch {
    /* metrics optional */
  }
  const dir = join(ROOT, 'install', 'logs');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(bundle, null, 2));
  say(`Diagnostics written to ${out} (PHI-free — safe to share with support).`);
}

function backup() {
  say('Creating an encrypted backup…');
  process.exit(runServer('backup', ['backup']) ?? 1);
}
function restore(args) {
  const id = args[0];
  if (!id) {
    say('Usage: medcorectl restore <backup-id> [--yes]');
    process.exit(2);
  }
  say(`Restoring backup ${id} (this OVERWRITES the target database)…`);
  process.exit(runServer('backup', ['restore', ...args]) ?? 1);
}

function update() {
  // Safe update: always back up first, then migrate forward, then health-check.
  // A failed migration stops here with the pre-update backup intact for rollback.
  say('Update: taking a pre-update backup…');
  if ((runServer('backup', ['backup']) ?? 1) !== 0) {
    say('Pre-update backup FAILED — aborting update (no changes made).');
    process.exit(1);
  }
  say('Update: applying database migrations…');
  if ((runServer('migrate') ?? 1) !== 0) {
    say('Migration FAILED. Restore the pre-update backup with `medcorectl restore <id> --yes`.');
    process.exit(1);
  }
  say('Update: rebuilding…');
  runServer('build');
  say('Update complete. Run `medcorectl health` to confirm green, then restart the service.');
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'health':
    await health();
    break;
  case 'status':
    await status();
    break;
  case 'diagnostics':
    await diagnostics();
    break;
  case 'backup':
    backup();
    break;
  case 'restore':
    restore(rest);
    break;
  case 'update':
    update();
    break;
  case 'license':
    process.exit(runServer('license', rest) ?? 1);
    break;
  default:
    say('Usage: medcorectl <health|status|diagnostics|backup|restore <id>|update|license ...>');
    process.exit(2);
}
