import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import { login, logout } from '../../modules/auth/auth.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const LoginSchema = z.object({
  clinicId: z.string().uuid(),
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Invalid login', parsed.error.flatten());
    const { clinicId, username, password } = parsed.data;
    const result = await login(clinicId, username, password, req.ip);
    return reply.send({
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      user: {
        id: result.principal.userId,
        username: result.principal.username,
        clinicId: result.principal.clinicId,
        roles: result.principal.roles,
        permissions: [...result.principal.permissions],
      },
    });
  });

  app.post('/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    const header = req.headers.authorization ?? '';
    const token = header.slice('Bearer '.length).trim();
    await logout(token);
    return reply.send({ ok: true });
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    const p = principalOf(req);
    return reply.send({
      id: p.userId,
      username: p.username,
      clinicId: p.clinicId,
      roles: p.roles,
      permissions: [...p.permissions],
    });
  });
}
