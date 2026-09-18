import type { FastifyInstance } from 'fastify';
import { principalOf, requireAuth } from '../plugins/auth.js';
import {
  getWhatsAppStatus,
  beginWhatsAppPairing,
  refreshWhatsAppStatus,
  disconnectWhatsApp,
} from '../../modules/messaging/whatsapp.service.js';

/**
 * WhatsApp connection HTTP surface — owned by Agent 3.
 *
 * Operator-facing pairing/status/reconnect for a clinic's WhatsApp device. No
 * endpoint accepts or returns a credential; the QR from `/pair` is transient and
 * only exists to be scanned. Authorization + tenant scope are enforced in the
 * service; these routes only require an authenticated session.
 */
export async function whatsappRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/whatsapp/status', async (req, reply) => {
    return reply.send(await getWhatsAppStatus(principalOf(req)));
  });

  app.post('/whatsapp/pair', async (req, reply) => {
    return reply.send(await beginWhatsAppPairing(principalOf(req)));
  });

  // Reconnect = re-poll the live device status and reconcile stored state.
  app.post('/whatsapp/reconnect', async (req, reply) => {
    return reply.send(await refreshWhatsAppStatus(principalOf(req)));
  });

  app.post('/whatsapp/disconnect', async (req, reply) => {
    return reply.send(await disconnectWhatsApp(principalOf(req)));
  });
}
