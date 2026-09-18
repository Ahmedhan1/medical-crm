import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../../modules/governance/rbac.js';
import { Permission } from '../../modules/governance/permissions.js';
import { getLicenseStatus } from '../../license/service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

/**
 * License status admin API (platform, Agent 1). `license:manage` (ADMIN) only.
 *
 * READ-ONLY and secret-free: it returns the license STATUS (edition, plan,
 * feature keys, validity window, offline-grace state) so an administrator can see
 * whether the box is licensed — never the signature, the public key, or anything
 * that could be replayed. Activation is an operator/first-run action
 * (`license-cli.ts` / the installer), not a web action, so a web session cannot
 * install or alter a license.
 */
export async function licenseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/admin/license', async (req, reply) => {
    requirePermission(principalOf(req), Permission.LICENSE_MANAGE);
    const s = await getLicenseStatus();
    return reply.send({
      status: s.status,
      boundOk: s.boundOk,
      clockRolledBack: s.clockRolledBack,
      installationId: s.installationId,
      license: s.license, // ids/plan/edition/features/dates only — no signature
    });
  });
}
