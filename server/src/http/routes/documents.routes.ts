import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import {
  getDocument,
  listPatientDocuments,
  registerDocument,
  voidDocument,
} from '../../modules/clinical/documents.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const IdParam = z.object({ id: z.string().uuid() });

/** Clinical document references (Agent 2 / Phase 9). */
export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  const idOf = (req: { params: unknown }): string => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    return parsed.data.id;
  };

  app.post('/documents', async (req, reply) => {
    const doc = await registerDocument(principalOf(req), req.body);
    return reply.code(201).send(doc);
  });

  app.get('/documents/:id', async (req, reply) => {
    return reply.send(await getDocument(principalOf(req), idOf(req)));
  });

  app.post('/documents/:id/void', async (req, reply) => {
    return reply.send(await voidDocument(principalOf(req), idOf(req), req.body));
  });

  app.get('/patients/:id/documents', async (req, reply) => {
    const documents = await listPatientDocuments(principalOf(req), idOf(req), req.query);
    return reply.send({ documents });
  });
}
