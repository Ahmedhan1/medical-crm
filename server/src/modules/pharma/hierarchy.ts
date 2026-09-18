import { getPool, type PoolClient } from '../../db/pool.js';
import { ConflictError } from '../../domain/errors.js';

type Runner = Pick<PoolClient, 'query'>;

/**
 * FIELD-FORCE MANAGEMENT HIERARCHY.
 *
 * `field_rep_profile.manager_user_id` describes who reports to whom. This module
 * is the only place that chain is walked, because walking it wrongly has two
 * failure modes that are both serious:
 *
 *  1. **Runaway recursion.** A data-entry mistake can create a cycle
 *     (A manages B manages A). An unguarded recursive CTE on a cyclic graph
 *     never terminates. Both guards below are therefore belt AND braces: a
 *     `path` array that refuses to revisit a user, and a hard depth cap.
 *  2. **Privilege creep.** A manager's reach must be their SUBTREE, not the
 *     clinic. `subordinateUserIds` returns strictly the people beneath a
 *     manager — never the manager themselves, never a peer, never everyone.
 *
 * The depth cap is a governance limit, not a performance one: a field force
 * with a reporting line more than ten deep is a modelling error, and silently
 * following it would be worse than truncating it.
 */
export const MAX_HIERARCHY_DEPTH = 10;

/**
 * Every user beneath `managerUserId` in the reporting chain, to the depth cap.
 *
 * Returns `[]` when the manager has no reports — which is the correct answer
 * for an ordinary representative, and is what keeps a rep scoped to themselves.
 */
export async function subordinateUserIds(
  clinicId: string,
  managerUserId: string,
  runner: Runner = getPool(),
  maxDepth: number = MAX_HIERARCHY_DEPTH,
): Promise<string[]> {
  const { rows } = await runner.query<{ user_id: string }>(
    `WITH RECURSIVE reports AS (
       SELECT p.user_id,
              1 AS depth,
              ARRAY[p.manager_user_id, p.user_id] AS seen
         FROM field_rep_profile p
        WHERE p.clinic_id = $1
          AND p.manager_user_id = $2
          AND p.user_id <> $2
       UNION ALL
       SELECT child.user_id,
              r.depth + 1,
              r.seen || child.user_id
         FROM field_rep_profile child
         JOIN reports r ON child.manager_user_id = r.user_id
        WHERE child.clinic_id = $1
          AND r.depth < $3
          -- Cycle protection: never revisit a user already on this path.
          AND NOT (child.user_id = ANY (r.seen))
     )
     SELECT DISTINCT user_id FROM reports`,
    [clinicId, managerUserId, maxDepth],
  );
  return rows.map((r) => r.user_id);
}

/**
 * The management chain ABOVE a user, nearest manager first.
 *
 * Used to answer "who does this escalation go to" and to prove a proposed
 * manager change does not fold the chain back on itself.
 */
export async function managerChainFor(
  clinicId: string,
  userId: string,
  runner: Runner = getPool(),
  maxDepth: number = MAX_HIERARCHY_DEPTH,
): Promise<string[]> {
  const { rows } = await runner.query<{ manager_user_id: string; depth: number }>(
    `WITH RECURSIVE chain AS (
       SELECT p.manager_user_id,
              1 AS depth,
              ARRAY[p.user_id] AS seen
         FROM field_rep_profile p
        WHERE p.clinic_id = $1
          AND p.user_id = $2
          AND p.manager_user_id IS NOT NULL
       UNION ALL
       SELECT parent.manager_user_id,
              c.depth + 1,
              c.seen || parent.user_id
         FROM field_rep_profile parent
         JOIN chain c ON parent.user_id = c.manager_user_id
        WHERE parent.clinic_id = $1
          AND parent.manager_user_id IS NOT NULL
          AND c.depth < $3
          AND NOT (parent.manager_user_id = ANY (c.seen))
     )
     SELECT manager_user_id, depth FROM chain ORDER BY depth`,
    [clinicId, userId, maxDepth],
  );
  return rows.map((r) => r.manager_user_id);
}

/**
 * Refuse a manager assignment that would create a cycle.
 *
 * A cycle is not merely untidy: it makes "who can see my data" unanswerable and,
 * without the guards above, unterminating. Checked in the service rather than in
 * SQL because a CHECK constraint cannot express reachability — the schema only
 * refuses the one-step case (`manager_user_id <> user_id`).
 */
export async function assertNoManagerCycle(
  clinicId: string,
  userId: string,
  proposedManagerUserId: string | null,
  runner: Runner = getPool(),
): Promise<void> {
  if (!proposedManagerUserId) return;
  if (proposedManagerUserId === userId) {
    throw new ConflictError('A field representative cannot report to themselves', {
      userId,
    });
  }
  // If the proposed manager already reports (directly or indirectly) to this
  // user, pointing this user at them closes the loop.
  const beneath = await subordinateUserIds(clinicId, userId, runner);
  if (beneath.includes(proposedManagerUserId)) {
    throw new ConflictError(
      'That manager already reports to this representative; the reporting line would form a cycle.',
      { userId, proposedManagerUserId },
    );
  }
}
