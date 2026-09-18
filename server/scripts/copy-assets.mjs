#!/usr/bin/env node
/**
 * Copy non-TypeScript runtime assets into dist/ after `tsc`, so the PRODUCTION
 * build (`node dist/index.js`) can find them. tsc only emits compiled .js, but
 * the app reads:
 *   - migration SQL files at runtime (migrate-on-boot), and
 *   - bundled PDF fonts.
 * Without this step the production artifact fails to boot ("no such file …
 * dist/db/migrations"). Cross-platform, dependency-free (node:fs.cpSync).
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const copies = [
  ['src/db/migrations', 'dist/db/migrations'],
  ['assets', 'dist/assets'],
];

for (const [from, to] of copies) {
  const src = join(SERVER, from);
  const dest = join(SERVER, to);
  if (!existsSync(src)) continue;
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  // eslint-disable-next-line no-console
  console.log(`[copy-assets] ${from} -> ${to}`);
}
