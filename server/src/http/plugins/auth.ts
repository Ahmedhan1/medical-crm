import type { FastifyReply, FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../../domain/errors.js';
import { authenticate } from '../../modules/auth/auth.service.js';
import type { Principal } from '../../modules/governance/rbac.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

/**
 * preHandler that requires a valid session. Attaches `req.principal`. Use on
 * every protected route; authorization (permissions/scope) is then enforced in
 * the services so it can never be skipped at the route layer.
 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractBearer(req);
  if (!token) throw new UnauthorizedError();
  const principal = await authenticate(token);
  if (!principal) throw new UnauthorizedError('Invalid or expired session');
  req.principal = principal;
}

/** Get the authenticated principal or throw (defensive; requireAuth ran first). */
export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw new UnauthorizedError();
  return req.principal;
}
