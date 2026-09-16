import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import { requirePermission } from '../../modules/governance/rbac.js';
import { Permission } from '../../modules/governance/permissions.js';
import {
  createBackup,
  listBackups,
  verifyBackup,
} from '../../modules/backup/backup.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const IdParam = z.object({ id: z.string().uuid() });

/**
 * Backup admin API (platform, Agent 1). `backup:manage` (ADMIN) only.
 *
 * Deliberately provides NO download and NO restore endpoint: backup artifacts
 * contain PHI, and restore is destructive. Both are operator CLI actions
 * (`backup-cli.ts`) so a compromised web session cannot exfiltrate a backup or
 * overwrite the live database.
 */
export async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.post('/admin/backups', async (req, reply) => {
    const principal = principalOf(req);
    requirePermission(principal, Permission.BACKUP_MANAGE);
    const run = await createBackup(principal.userId, 'manual');
    return reply.code(201).send(run);
  });

  app.get('/admin/backups', async (req, reply) => {
    requirePermission(principalOf(req), Permission.BACKUP_MANAGE);
    return reply.send({ backups: await listBackups(50) });
  });

  app.post('/admin/backups/:id/verify', async (req, reply) => {
    const principal = principalOf(req);
    requirePermission(principal, Permission.BACKUP_MANAGE);
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    const result = await verifyBackup(principal.userId, parsed.data.id);
    return reply.code(result.ok ? 200 : 422).send(result);
  });
}
