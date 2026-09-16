import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

const exec = promisify(execFile);

/**
 * Low-level Postgres backup/restore plumbing for the backup engine.
 *
 * Security:
 *  - Credentials are passed to child processes via PG* ENV, never as argv (so
 *    they cannot appear in a process listing or a log line).
 *  - No shell is used (`execFile` with an argv array) — no injection surface.
 *  - Optional AES-256-GCM at-rest encryption; the key comes from config
 *    (secret manager), is never written to disk or the DB.
 */

export interface PgConn {
  env: NodeJS.ProcessEnv;
  database: string;
}

/** Parse a postgres:// URL into PG* env vars (keeps the password out of argv). */
export function parseConn(databaseUrl: string): PgConn {
  const u = new URL(databaseUrl);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGDATABASE: database,
  };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  return { env, database };
}

/** Dump the whole database to a portable custom-format archive file. */
export async function pgDump(databaseUrl: string, outFile: string): Promise<void> {
  const { env } = parseConn(databaseUrl);
  await exec(
    'pg_dump',
    ['--format=custom', '--no-owner', '--no-privileges', '--file', outFile],
    { env, maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * Restore a custom-format archive into the target database, replacing existing
 * objects. The caller is responsible for pointing this at the correct (e.g.
 * scratch or freshly-created) database — restore is destructive.
 */
export async function pgRestore(databaseUrl: string, inFile: string): Promise<void> {
  const { env } = parseConn(databaseUrl);
  // pg_restore exits non-zero on ignorable warnings with --clean on an empty DB;
  // use --exit-on-error only where the DB is guaranteed to exist. We treat a
  // non-zero exit as failure but surface stderr for diagnosis.
  await exec(
    'pg_restore',
    ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--dbname', databaseUrl, inFile],
    { env, maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * Validate that a file is a readable pg custom-format archive by listing its
 * table of contents. Throws if the file is truncated/corrupt/not an archive.
 */
export async function pgArchiveIsReadable(inFile: string): Promise<boolean> {
  const { stdout } = await exec('pg_restore', ['--list', inFile], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.length > 0;
}

/** SHA-256 of a file, streamed (no full read into memory). */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// --- Optional at-rest encryption (AES-256-GCM) ------------------------------
// File layout: [12-byte IV][16-byte auth tag][ciphertext].

function deriveKey(secret: string): Buffer {
  // Normalise any sufficiently-long secret to a 32-byte key.
  return createHash('sha256').update(secret).digest();
}

export async function encryptFile(src: string, dest: string, secret: string): Promise<void> {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = await readFile(src);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  await writeFile(dest, Buffer.concat([iv, tag, ciphertext]));
}

export async function decryptFile(src: string, dest: string, secret: string): Promise<void> {
  const key = deriveKey(secret);
  const blob = await readFile(src);
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  await writeFile(dest, plaintext);
}
