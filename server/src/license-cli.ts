/**
 * MEDCORE License operator CLI (box-side). Safe operations only — it never sees or
 * needs the vendor private key.
 *
 *   tsx src/license-cli.ts install-id            # print this box's installation id
 *   tsx src/license-cli.ts activate <license.json>
 *   tsx src/license-cli.ts status                # human-readable current status
 */
import { readFileSync } from 'node:fs';
import type { SignedEntitlement } from './modules/platform/entitlement/index.js';
import { activateLicense, getLicenseStatus } from './license/service.js';
import { loadOrCreateInstallation } from './license/store.js';

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'install-id') {
    const inst = loadOrCreateInstallation();
    // eslint-disable-next-line no-console
    console.log(inst.installationId);
    return;
  }
  if (cmd === 'activate') {
    const file = process.argv[3];
    if (!file) throw new Error('Usage: license-cli.ts activate <license.json>');
    const signed = JSON.parse(readFileSync(file, 'utf8')) as SignedEntitlement;
    const status = await activateLicense(signed);
    // eslint-disable-next-line no-console
    console.log(`[license] activated — status=${status.status} plan=${status.license?.plan}`);
    return;
  }
  if (cmd === 'status') {
    const s = await getLicenseStatus();
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          status: s.status,
          plan: s.license?.plan,
          edition: s.license?.edition,
          expiresAt: s.license?.expiresAt,
          graceDays: s.license?.graceDays,
          boundOk: s.boundOk,
          clockRolledBack: s.clockRolledBack,
          installationId: s.installationId,
        },
        null,
        2,
      ),
    );
    return;
  }
  // eslint-disable-next-line no-console
  console.error('Usage: license-cli.ts <install-id|activate <file>|status>');
  process.exit(2);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`[license] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
