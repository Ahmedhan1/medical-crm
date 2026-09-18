import { z } from 'zod';
import { getPool, withTransaction } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { SERVICE_COLS, mapService, type BillableService } from './billing.repo.js';

/** Billable-service price catalog. Managed by ADMIN (`billing:config`); read by
 * anyone who may build an invoice (`billing:read`). Clinic-scoped throughout. */

export const CreateServiceSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
  unitPriceMinor: z.number().int().min(0),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).default('EGP'),
  taxRateBp: z.number().int().min(0).max(10000).default(0),
});

export const UpdateServiceSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  unitPriceMinor: z.number().int().min(0).optional(),
  taxRateBp: z.number().int().min(0).max(10000).optional(),
  isActive: z.boolean().optional(),
});

export async function createService(principal: Principal, raw: unknown): Promise<BillableService> {
  requirePermission(principal, Permission.BILLING_CONFIG);
  const parsed = CreateServiceSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid service', parsed.error.flatten());
  const d = parsed.data;
  return withTransaction(async (client) => {
    try {
      const { rows } = await client.query(
        `INSERT INTO billable_service (clinic_id, code, name, unit_price_minor, currency, tax_rate_bp, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${SERVICE_COLS}`,
        [principal.clinicId, d.code, d.name, d.unitPriceMinor, d.currency, d.taxRateBp, principal.userId],
      );
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'billing.service.create',
        outcome: 'success',
        targetType: 'billable_service',
        targetId: rows[0]!.id,
        metadata: { code: d.code, unitPriceMinor: d.unitPriceMinor },
      });
      return mapService(rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError('A billable service with that code already exists');
      }
      throw err;
    }
  });
}

export async function updateService(
  principal: Principal,
  serviceId: string,
  raw: unknown,
): Promise<BillableService> {
  requirePermission(principal, Permission.BILLING_CONFIG);
  const parsed = UpdateServiceSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid service update', parsed.error.flatten());
  const d = parsed.data;
  const sets: string[] = [];
  const values: unknown[] = [principal.clinicId, serviceId];
  for (const [key, col] of [
    ['name', 'name'],
    ['unitPriceMinor', 'unit_price_minor'],
    ['taxRateBp', 'tax_rate_bp'],
    ['isActive', 'is_active'],
  ] as const) {
    if (d[key] !== undefined) {
      values.push(d[key]);
      sets.push(`${col} = $${values.length}`);
    }
  }
  if (sets.length === 0) throw new ValidationError('No fields to update');
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE billable_service SET ${[...sets, 'updated_at = now()'].join(', ')}
        WHERE clinic_id = $1 AND id = $2 RETURNING ${SERVICE_COLS}`,
      values,
    );
    if (!rows[0]) throw new NotFoundError('Billable service');
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'billing.service.update',
      outcome: 'success',
      targetType: 'billable_service',
      targetId: serviceId,
      metadata: { fields: sets.length },
    });
    return mapService(rows[0]!);
  });
}

export const ListServicesQuery = z.object({
  includeInactive: z.coerce.boolean().default(false),
});

export async function listServices(principal: Principal, rawQuery: unknown): Promise<BillableService[]> {
  requirePermission(principal, Permission.BILLING_READ);
  const parsed = ListServicesQuery.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());
  const { rows } = await getPool().query(
    `SELECT ${SERVICE_COLS} FROM billable_service
      WHERE clinic_id = $1 AND ($2::boolean OR is_active)
      ORDER BY is_active DESC, name`,
    [principal.clinicId, parsed.data.includeInactive],
  );
  return rows.map(mapService);
}

/** Fetch active services by id, clinic-scoped — used when building an invoice
 * line from the catalog. Returns a map so the caller can validate all ids. */
export async function getServicesByIds(
  clinicId: string,
  ids: string[],
  runner: Pick<import('../../db/pool.js').PoolClient, 'query'> = getPool(),
): Promise<Map<string, BillableService>> {
  if (ids.length === 0) return new Map();
  const { rows } = await runner.query(
    `SELECT ${SERVICE_COLS} FROM billable_service
      WHERE clinic_id = $1 AND id = ANY($2::uuid[])`,
    [clinicId, ids],
  );
  return new Map(rows.map((r) => [r.id as string, mapService(r)]));
}
