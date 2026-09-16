import { getPool, withTransaction } from '../../../db/pool.js';
import { auditTx } from '../../governance/audit.js';
import { requirePermission, type Principal } from '../../governance/rbac.js';
import { Permission } from '../../governance/permissions.js';
import { runIntakeEval, runSummaryEval, type EvalReport } from './runner.js';

/**
 * AI evaluation service (E5). Runs the deterministic, PHI-free evaluation suites
 * over synthetic fixtures and persists a ledger entry per suite. Stored reports
 * contain only fixture ids + numeric scores + provider/model metadata — never
 * fixture text, prompts, outputs, or PHI.
 */
export interface EvalRunResult {
  intake: EvalReport;
  summary: EvalReport;
  runIds: string[];
}

export async function runAndRecordEval(principal: Principal): Promise<EvalRunResult> {
  requirePermission(principal, Permission.AI_EVAL_RUN);

  const intake = await runIntakeEval();
  const summary = await runSummaryEval();

  const runIds = await withTransaction(async (client) => {
    const ids: string[] = [];
    for (const report of [intake, summary]) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO ai_eval_run
           (clinic_id, suite, provider, model, total, passed, failed, avg_latency_ms, report, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          principal.clinicId,
          report.suite,
          report.provider,
          report.model ?? null,
          report.total,
          report.passed,
          report.failed,
          report.avgLatencyMs,
          JSON.stringify(report),
          principal.userId,
        ],
      );
      ids.push(rows[0]!.id);
    }
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'ai.eval.run',
      outcome: 'success',
      targetType: 'ai_eval_run',
      metadata: {
        intake: `${intake.passed}/${intake.total}`,
        summary: `${summary.passed}/${summary.total}`,
      },
    });
    return ids;
  });

  return { intake, summary, runIds };
}

export interface EvalRunRow {
  id: string;
  suite: string;
  provider: string;
  model: string | null;
  total: number;
  passed: number;
  failed: number;
  avgLatencyMs: number | null;
  createdAt: string;
}

export async function listEvalRuns(principal: Principal, limit = 50): Promise<EvalRunRow[]> {
  requirePermission(principal, Permission.AI_EVAL_RUN);
  const { rows } = await getPool().query<{
    id: string; suite: string; provider: string; model: string | null;
    total: number; passed: number; failed: number; avg_latency_ms: string | null; created_at: string;
  }>(
    `SELECT id, suite, provider, model, total, passed, failed, avg_latency_ms, created_at
       FROM ai_eval_run WHERE clinic_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [principal.clinicId, Math.min(limit, 200)],
  );
  return rows.map((r) => ({
    id: r.id,
    suite: r.suite,
    provider: r.provider,
    model: r.model,
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    avgLatencyMs: r.avg_latency_ms === null ? null : Number(r.avg_latency_ms),
    createdAt: r.created_at,
  }));
}
