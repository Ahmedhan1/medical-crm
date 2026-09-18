import type { FastifyInstance } from 'fastify';
import { automationRoutes } from '../routes/automation.routes.js';
import { messagingRoutes } from '../routes/messaging.routes.js';
import { aiRoutes } from '../routes/ai.routes.js';
import { whatsappRoutes } from '../routes/whatsapp.routes.js';
import { configureWhatsAppFromConfig } from '../../modules/messaging/providers/whatsapp/registry.js';

/**
 * AI / AUTOMATION / WHATSAPP feature routes — owned by Agent 3.
 * This is the ONLY place Agent 3 wires HTTP routes; `server.ts` never changes.
 */
export async function automationFeature(app: FastifyInstance): Promise<void> {
  // Wire the GOWA WhatsApp provider from config (no-op when unconfigured, so the
  // box stays offline-capable and tests are deterministic).
  configureWhatsAppFromConfig();
  await app.register(automationRoutes);
  await app.register(messagingRoutes);
  await app.register(aiRoutes);
  await app.register(whatsappRoutes);
}
