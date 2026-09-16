import { authorizeAiAction, type AiActionRequest, type AiActionDecision } from './guard.js';
import { getTool } from './tools.js';
import { recordActionDecision } from './action-log.js';

/**
 * executeAiAction (E4) — THE execution boundary. Any AI-initiated action goes
 * through this function; it authorizes FIRST and only runs the tool handler on
 * an ALLOW. There is no other path from an AI actor to a tool handler, so a
 * future AI developer cannot execute an action without passing the guard.
 *
 * Non-ALLOW decisions (deny / require_confirmation) never execute. Every
 * decision is logged (append-only, no PHI, no arguments).
 */
export interface ExecuteAiActionInput extends AiActionRequest {
  /** Tool arguments. NEVER logged (may contain PHI); passed only to the handler. */
  args?: Record<string, unknown>;
}

export interface ExecuteAiActionResult {
  authorization: AiActionDecision;
  executed: boolean;
  reason?: string;
  result?: unknown;
}

export async function executeAiAction(input: ExecuteAiActionInput): Promise<ExecuteAiActionResult> {
  const authorization = await authorizeAiAction(input);

  if (authorization.decision !== 'allow') {
    await recordActionDecision(authorization, { executed: false, createdBy: input.actorId ?? null });
    return { authorization, executed: false, reason: authorization.reasonCode };
  }

  const tool = getTool(input.toolId);
  // Guard already proved the tool exists and is permitted; a missing handler
  // means it is an authorization-only entry (real handler deferred to its owner).
  if (!tool?.handler) {
    await recordActionDecision(authorization, { executed: false, createdBy: input.actorId ?? null });
    return { authorization, executed: false, reason: 'no_handler' };
  }

  try {
    const result = await tool.handler(
      { clinicId: input.clinicId, identityId: input.identityId, requestId: authorization.requestId, actorId: input.actorId },
      input.args ?? {},
    );
    await recordActionDecision(authorization, { executed: true, createdBy: input.actorId ?? null });
    return { authorization, executed: true, result };
  } catch {
    // Never surface handler internals or arguments; record a generic failure.
    await recordActionDecision(authorization, { executed: false, createdBy: input.actorId ?? null });
    return { authorization, executed: false, reason: 'handler_error' };
  }
}
