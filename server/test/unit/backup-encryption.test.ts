import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptFile, decryptFile } from '../../src/modules/backup/pg.js';
import { selectForRetention } from '../../src/modules/backup/backup.service.js';

const dirs: string[] = [];
async function scratchDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'medcore-bk-'));
  dirs.push(d);
  return d;
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('backup encryption (AES-256-GCM)', () => {
  const key = 'a-very-long-backup-encryption-key-0123456789';

  it('round-trips a file byte-for-byte', async () => {
    const d = await scratchDir();
    const src = join(d, 'plain.bin');
    const enc = join(d, 'cipher.enc');
    const out = join(d, 'plain.out');
    const data = Buffer.concat([Buffer.from('PGDMP fake archive '), Buffer.from([0, 1, 2, 255, 254])]);
    await writeFile(src, data);

    await encryptFile(src, enc, key);
    const cipher = await readFile(enc);
    expect(cipher.equals(data)).toBe(false); // actually encrypted
    expect(cipher.length).toBeGreaterThan(data.length); // iv+tag prepended

    await decryptFile(enc, out, key);
    expect((await readFile(out)).equals(data)).toBe(true);
  });

  it('rejects a tampered ciphertext (auth tag)', async () => {
    const d = await scratchDir();
    const src = join(d, 'p.bin');
    const enc = join(d, 'c.enc');
    await writeFile(src, Buffer.from('sensitive backup bytes'));
    await encryptFile(src, enc, key);
    const blob = await readFile(enc);
    const last = blob.length - 1;
    blob[last] = (blob[last] ?? 0) ^ 0xff; // flip a ciphertext bit
    await writeFile(enc, blob);
    await expect(decryptFile(enc, join(d, 'o.bin'), key)).rejects.toThrow();
  });

  it('rejects the wrong key', async () => {
    const d = await scratchDir();
    const src = join(d, 'p.bin');
    const enc = join(d, 'c.enc');
    await writeFile(src, Buffer.from('sensitive backup bytes'));
    await encryptFile(src, enc, key);
    await expect(
      decryptFile(enc, join(d, 'o.bin'), 'a-different-long-key-0123456789-abcdefgh'),
    ).rejects.toThrow();
  });
});

describe('backup retention (GFS selector)', () => {
  it('keeps newest per day/week/month up to the policy and marks the rest removable', () => {
    // 10 daily backups over 10 consecutive days.
    const runs = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      startedAt: new Date(Date.UTC(2026, 0, 20 - i, 3, 0, 0)).toISOString(),
    }));
    const { keep, remove } = selectForRetention(runs, { daily: 3, weekly: 2, monthly: 1 });
    // Newest 3 days kept; plus week/month picks (which coincide with recent days here).
    expect(keep).toContain('r0');
    expect(keep).toContain('r1');
    expect(keep).toContain('r2');
    // Something old is removed, and keep+remove partition the set with no overlap.
    expect(remove.length).toBeGreaterThan(0);
    expect(keep.length + remove.length).toBe(runs.length);
    expect(keep.some((id) => remove.includes(id))).toBe(false);
  });

  it('keeps everything when the policy is larger than the set', () => {
    const runs = [
      { id: 'a', startedAt: '2026-01-10T00:00:00.000Z' },
      { id: 'b', startedAt: '2026-01-09T00:00:00.000Z' },
    ];
    const { remove } = selectForRetention(runs, { daily: 7, weekly: 4, monthly: 3 });
    expect(remove).toEqual([]);
  });
});
