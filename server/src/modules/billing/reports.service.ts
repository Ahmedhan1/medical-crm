import { z } from 'zod';
import { getPool } from '../../db/pool.js';
import { ValidationError } from '../../domain/errors.js';
import { audit } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';

/**
 * Financial reporting. The DATABASE is the source of truth: every figure is a
 * SQL aggregate over the persisted `payment` / `invoice` rows, clinic-scoped.
 * Revenue is CASH-BASIS — the sum of COMPLETED payments in the window — so a
 * reversed payment drops out and nothing is double counted. Outstanding is a
 * point-in-time snapshot of current balances. No table is loaded into memory.
 */

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const RangeQuery = z.object({
  from: DateStr.optional(),
  to: DateStr.optional(),
});

function resolveRange(q: { from?: string; to?: string }): { from: string; to: string } {
  // Default: current month to today (inclusive). `to` is exclusive-of-next-day in SQL.
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const from = q.from ?? iso(new Date(today.getFullYear(), today.getMonth(), 1));
  const to = q.to ?? iso(today);
  if (from > to) throw new ValidationError('`from` must not be after `to`');
  return { from, to };
}

export interface FinancialSummary {
  from: string;
  to: string;
  currency: string;
  revenueMinor: number;
  paymentCount: number;
  issuedInvoiceCount: number;
  paidInvoiceCount: number;
  outstandingMinor: number;
  outstandingInvoiceCount: number;
  byMethod: Array<{ method: string; amountMinor: number; count: number }>;
}

export async function getFinancialSummary(principal: Principal, rawQuery: unknown): Promise<FinancialSummary> {
  requirePermission(principal, Permission.BILLING_REPORT);
  const parsed = RangeQuery.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());
  const { from, to } = resolveRange(parsed.data);
  const pool = getPool();
  const args = [principal.clinicId, from, to];

  // Cash-basis revenue + payment count, completed payments in the window.
  const revenue = await pool.query<{ revenue: string; n: string }>(
    `SELECT COALESCE(SUM(amount_minor),0)::text AS revenue, count(*)::text AS n
       FROM payment
      WHERE clinic_id = $1 AND status = 'completed'
        AND paid_at >= $2::date AND paid_at < ($3::date + 1)`,
    args,
  );
  // Invoices issued in the window; paid ones among all-time (paid_at in window).
  const issued = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM invoice
      WHERE clinic_id = $1 AND issued_at >= $2::date AND issued_at < ($3::date + 1)`,
    args,
  );
  const paid = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM invoice
      WHERE clinic_id = $1 AND status = 'paid'
        AND paid_at >= $2::date AND paid_at < ($3::date + 1)`,
    args,
  );
  // Outstanding is point-in-time (not window-bound): everything still owed now.
  const outstanding = await pool.query<{ amt: string; n: string }>(
    `SELECT COALESCE(SUM(balance_due_minor),0)::text AS amt, count(*)::text AS n
       FROM invoice
      WHERE clinic_id = $1 AND status IN ('issued','partially_paid')`,
    [principal.clinicId],
  );
  const byMethod = await pool.query<{ method: string; amt: string; n: string }>(
    `SELECT method, COALESCE(SUM(amount_minor),0)::text AS amt, count(*)::text AS n
       FROM payment
      WHERE clinic_id = $1 AND status = 'completed'
        AND paid_at >= $2::date AND paid_at < ($3::date + 1)
      GROUP BY method ORDER BY method`,
    args,
  );

  await audit({
    clinicId: principal.clinicId, actorId: principal.userId, action: 'billing.report.summary',
    outcome: 'success', targetType: 'clinic', targetId: principal.clinicId, metadata: { from, to },
  });

  return {
    from,
    to,
    currency: 'EGP',
    revenueMinor: Number(revenue.rows[0]!.revenue),
    paymentCount: Number(revenue.rows[0]!.n),
    issuedInvoiceCount: Number(issued.rows[0]!.n),
    paidInvoiceCount: Number(paid.rows[0]!.n),
    outstandingMinor: Number(outstanding.rows[0]!.amt),
    outstandingInvoiceCount: Number(outstanding.rows[0]!.n),
    byMethod: byMethod.rows.map((r) => ({ method: r.method, amountMinor: Number(r.amt), count: Number(r.n) })),
  };
}

const RevenueSeriesQuery = RangeQuery.extend({
  granularity: z.enum(['day', 'month']).default('day'),
});

export interface RevenuePoint {
  period: string;
  revenueMinor: number;
  paymentCount: number;
}

export async function getRevenueSeries(principal: Principal, rawQuery: unknown): Promise<{ from: string; to: string; granularity: string; points: RevenuePoint[] }> {
  requirePermission(principal, Permission.BILLING_REPORT);
  const parsed = RevenueSeriesQuery.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());
  const { from, to } = resolveRange(parsed.data);
  const granularity = parsed.data.granularity;
  const { rows } = await getPool().query<{ period: string; amt: string; n: string }>(
    `SELECT to_char(date_trunc($4, paid_at), $5) AS period,
            COALESCE(SUM(amount_minor),0)::text AS amt, count(*)::text AS n
       FROM payment
      WHERE clinic_id = $1 AND status = 'completed'
        AND paid_at >= $2::date AND paid_at < ($3::date + 1)
      GROUP BY 1 ORDER BY 1`,
    [principal.clinicId, from, to, granularity, granularity === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'],
  );
  return {
    from,
    to,
    granularity,
    points: rows.map((r) => ({ period: r.period, revenueMinor: Number(r.amt), paymentCount: Number(r.n) })),
  };
}
