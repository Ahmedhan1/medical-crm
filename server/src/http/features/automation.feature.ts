import type { FastifyInstance } from 'fastify';
import { automationRoutes } from '../routes/automation.routes.js';
import { messagingRoutes } from '../routes/messaging.routes.js';
import { aiRoutes } from '../routes/ai.routes.js';

/**
 * AI / AUTOMATION / WHATSAPP feature routes — owned by Agent 3.
 * This is the ONLY place Agent 3 wires HTTP routes; `server.ts` never changes.
 */
export async function automationFeature(app: FastifyInstance): Promise<void> {
  await app.register(automationRoutes);
  await app.register(messagingRoutes);
  await app.register(aiRoutes);
}
